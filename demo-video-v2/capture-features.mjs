// Records one short, real clip per Explore Better feature for the website feature grid.
//
//   npm run capture:features                 all clips (about eight minutes)
//   npm run capture:features -- --only terminal,search
//
// Safety matches capture-app-footage.mjs: everything runs inside a disposable demo root
// (default C:\Demo, override with EB_DEMO_ROOT) that must not exist yet or must carry the
// marker this script writes, and it is removed afterwards. The app gets its own profile,
// LOCALAPPDATA, APPDATA and Electron user data inside that root, so the user's real files,
// settings and AI Bridge configuration are never read or written. Nothing touches the
// registry, and Explorer integration is never opened.
//
// The UI renders at 1440x900 CSS pixels (the site's screenshot size) at the display's own
// device scale, so the 1280x800 web clips can push in without upscaling. Each clip is its own screencast,
// re-timed to a constant 30 fps from the frame timestamps, with markers, keypresses, element
// rectangles (CSS pixels, which are also edit pixels) and on-screen text written to
// capture/features/manifest.json. src/features-edit.mjs cuts every clip relative to those.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { chromium } from "playwright-core";
import { createFeatureFixture, createLargeFolder } from "./src/features-fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");
const workDir = path.join(root, "demo-video-v2");
const captureDir = path.join(workDir, "capture", "features");
const electronApp = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const repoSidecar = path.join(root, "native", "bin", "ExploreBetterMcp.exe");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const demoRoot = path.resolve(process.env.EB_DEMO_ROOT || "C:\\Demo");
const markerFile = path.join(demoRoot, ".explore-better-demo-workspace");
// The device scale factor follows the display's own (the terminal only paints correctly when
// the emulated and real scale factors match); on a 150% display the source is 2160x1350.
const viewport = { width: 1440, height: 900, scale: 1 };
const sourceSize = () => ({ width: Math.round(viewport.width * viewport.scale / 2) * 2, height: Math.round(viewport.height * viewport.scale / 2) * 2 });
const FPS = 30;
// Text that must never be visible in a clip: the capturing account and the repository path.
const sensitiveNeedles = [...new Set([os.userInfo().username, os.homedir(), root, "\\users\\"]
  .map((value) => String(value || "").toLowerCase()).filter((value) => value.length >= 3))];

const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : null;
};
// --attach <port> drives an app that is already running on that CDP port (development only).
const attachPort = argValue("--attach");
const ORDER = [
  "dual-pane", "command-palette", "keyboard", "safe-rename", "previews", "search", "disk-map",
  "compare-sync", "transfer", "terminal", "ai-handoff", "ai-profile", "large-folder"
];
const only = argValue("--only")?.split(",").map((item) => item.trim()).filter(Boolean);
if (only) for (const id of only) if (!ORDER.includes(id)) throw new Error(`Unknown clip ${id}. Known: ${ORDER.join(", ")}`);
const selected = ORDER.filter((id) => !only || only.includes(id));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    await sleep(120);
  }
  throw new Error(message);
}

async function prepareDemoRoot() {
  for (let attempt = 0; attempt < 40 && existsSync(demoRoot) && !existsSync(markerFile); attempt += 1) await sleep(250);
  if (existsSync(demoRoot)) {
    if (!existsSync(markerFile)) throw new Error(`${demoRoot} already exists and is not a previous demo workspace. Set EB_DEMO_ROOT to an unused folder.`);
    await fs.rm(demoRoot, { recursive: true, force: true, maxRetries: 5 });
  }
  await fs.mkdir(demoRoot, { recursive: true });
  await fs.writeFile(markerFile, "Disposable Explore Better demo workspace. Safe to delete.\n");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with ${code}`)));
  });
}

function findCodexCli() {
  if (process.env.EB_DEMO_MCP_CLIENT === "scripted") return null;
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  const found = spawnSync("where", ["codex"], { encoding: "utf8", windowsHide: true });
  const candidates = String(found.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => /\.exe$/i.test(line));
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

const PROFILE_TOOLS = [
  "get_context", "list_locations", "show_in_explore_better", "list_directory", "search_files",
  "inspect_paths", "read_text", "compute_checksums", "get_index_status", "analyze_disk_usage",
  "find_duplicates", "compare_folders", "get_job", "cancel_job", "list_collections", "list_labels",
  "get_operation"
];

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
    return { tool: item.tool, detail: `${pane} pane / ${path.basename(data.panes?.[pane]?.path || "")}` };
  }
  if (item.tool === "search_files") {
    const count = Array.isArray(data.entries) ? data.entries.length : 0;
    return { tool: item.tool, detail: `"${item.arguments?.query || ""}" / ${count} match${count === 1 ? "" : "es"}` };
  }
  if (item.tool === "show_in_explore_better") {
    return { tool: item.tool, detail: `${path.basename(data.shown || item.arguments?.path || "")} / ${data.pane || "active"} pane` };
  }
  return { tool: item.tool, detail: "" };
}

// ---------------------------------------------------------------------------------------------
// App session

await fs.access(electronApp);
if (only) await fs.mkdir(captureDir, { recursive: true });
else {
  await fs.rm(captureDir, { recursive: true, force: true });
  await fs.mkdir(captureDir, { recursive: true });
}
const manifestPath = path.join(captureDir, "manifest.json");
const manifest = existsSync(manifestPath) ? JSON.parse(await fs.readFile(manifestPath, "utf8")) : { clips: {} };

let fixture;
let app = null;
let logs = "";
if (attachPort) {
  fixture = {
    user: path.join(demoRoot, "User"),
    left: path.join(demoRoot, "Project files"),
    right: path.join(demoRoot, "Release ready")
  };
  fixture.picks = path.join(fixture.left, "Client picks");
  fixture.rightPicks = path.join(fixture.right, "Client picks");
} else {
  await prepareDemoRoot();
  fixture = await createFeatureFixture(demoRoot, root);
}
const localAppData = path.join(fixture.user, "AppData", "Local");
const roamingAppData = path.join(fixture.user, "AppData", "Roaming");
const userData = path.join(roamingAppData, "Explore Better Demo");
if (!attachPort) {
  await fs.mkdir(path.join(localAppData, "ExploreBetter", "MCP"), { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(path.join(localAppData, "ExploreBetter", "MCP", "bridge-config.json"), `${JSON.stringify({
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
      tools: PROFILE_TOOLS,
      allowPermanentDelete: false,
      createdAt: now,
      updatedAt: now,
      lastConnectedAt: null
    }],
    updatedAt: now
  }, null, 2)}\n`, "utf8");
}

const port = attachPort ? Number(attachPort) : await freePort();
if (!attachPort) {
  app = spawn(electronApp, [
    root, fixture.left, "--no-updates", `--remote-debugging-port=${port}`,
    "--disable-features=CalculateNativeWinOcclusion", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"
  ], {
    cwd: root,
    env: {
      ...process.env,
      USERPROFILE: fixture.user,
      HOME: fixture.user,
      HOMEDRIVE: path.parse(fixture.user).root.replace(/\\$/, ""),
      HOMEPATH: fixture.user.slice(path.parse(fixture.user).root.length - 1),
      LOCALAPPDATA: localAppData,
      APPDATA: roamingAppData,
      PSModuleAnalysisCachePath: path.join(localAppData, "PowerShell", "ModuleAnalysisCache"),
      EXPLORE_BETTER_USER_DATA_DIR: userData,
      EXPLORE_BETTER_WORKSPACE_ROOT: demoRoot,
      EXPLORE_BETTER_UPDATE_URL: ""
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  app.stdout.on("data", (chunk) => { logs += chunk; });
  app.stderr.on("data", (chunk) => { logs += chunk; });
}

let browser;
let client;
try {
  await waitFor(async () => {
    if (app && app.exitCode !== null) throw new Error(`Explore Better exited before CDP was ready (${app.exitCode}).`);
    return fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.ok, () => false);
  }, 30_000, "Timed out waiting for Explore Better.");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await waitFor(
    () => browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith("http://127.0.0.1")),
    30_000,
    "Explore Better renderer was not available through CDP."
  );
  client = await page.context().newCDPSession(page);
  viewport.scale = Math.min(2, Math.max(1, Number((await page.evaluate(() => window.devicePixelRatio)).toFixed(2))));
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
    const input = page.locator(`[data-path-input="${pane}"]`);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await input.inputValue() === target) return;
      await input.fill(target);
      await page.waitForTimeout(200);
      await input.press("Enter");
      const arrived = await page.waitForFunction(([name, expected]) => document.querySelector(`[data-path-input="${name}"]`)?.value === expected, [pane, target], { timeout: 5_000 }).then(() => true, () => false);
      if (arrived) return;
      await page.keyboard.press("Escape").catch(() => {});
    }
    throw new Error(`Could not open ${target} in the ${pane} pane.`);
  };
  await dismissPrompts();

  // A restrained lime pointer and a 30 fps repaint heartbeat. Neither changes app behaviour.
  await page.evaluate(() => {
    if (document.getElementById("demo-cursor")) return;
    const style = document.createElement("style");
    style.textContent = `
      #demo-cursor { position:fixed; z-index:2147483647; width:15px; height:15px; border:2px solid #111715; border-radius:50%; background:#c7ff4a; pointer-events:none; transform:translate(-50%,-50%); box-shadow:0 2px 10px rgba(17,23,21,.35); transition:left .42s cubic-bezier(.2,.9,.25,1), top .42s cubic-bezier(.2,.9,.25,1), opacity .25s; }
      #demo-cursor.click::after { content:""; position:absolute; inset:-9px; border:2px solid #c7ff4a; border-radius:50%; animation:demo-ring .42s ease-out both; }
      #demo-cursor.hidden { opacity:0; }
      #demo-cursor.instant { transition:opacity .25s; }
      #demo-heartbeat { position:fixed; left:0; top:0; width:2px; height:2px; opacity:.01; background:#c7ff4a; pointer-events:none; }
      @keyframes demo-ring { from { transform:scale(.2); opacity:1; } to { transform:scale(1.55); opacity:0; } }
    `;
    document.head.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.className = "hidden";
    cursor.style.left = "640px";
    cursor.style.top = "420px";
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

  // ---- Recording --------------------------------------------------------------------------
  let rec = null;
  client.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
    client.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    if (!rec || rec.stopped) return;
    if (!rec.firstWall) {
      rec.firstWall = Date.now();
      rec.firstStamp = metadata.timestamp;
    }
    const file = path.join(rec.frameDir, `frame-${String(rec.frames.length).padStart(6, "0")}.jpg`);
    rec.frames.push({ file, seconds: metadata.timestamp - rec.firstStamp });
    rec.writes = rec.writes.then(() => fs.writeFile(file, Buffer.from(data, "base64")));
  });
  const clock = () => Number(((Date.now() - (rec?.firstWall || Date.now())) / 1000).toFixed(3));
  const mark = (id) => { rec?.markers.push({ id, seconds: clock() }); };
  const begin = async (id) => {
    const frameDir = path.join(captureDir, `${id}-frames`);
    await fs.rm(frameDir, { recursive: true, force: true });
    await fs.mkdir(frameDir, { recursive: true });
    rec = { id, frameDir, frames: [], writes: Promise.resolve(), markers: [], keys: [], rects: {}, texts: {}, firstWall: 0, firstStamp: 0 };
    // Privacy watchdog: if either pane ever shows a folder outside the demo root, the clip
    // is discarded (frames deleted) instead of encoded.
    const watched = rec;
    // Any on-screen text naming the capturing user (such as the dev build's client snippet,
    // which contains the repository path) taints the clip the same way.
    watched.watchdog = setInterval(async () => {
      const found = await page.evaluate(([root, needles]) => {
        const paths = [...document.querySelectorAll("[data-path-input]")].map((input) => input.value);
        const outside = paths.find((value) => value && !value.toLowerCase().startsWith(root.toLowerCase()));
        if (outside) return outside;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.nodeValue.toLowerCase();
          // Check the exact characters of each match, so a long text node that is only partly
          // scrolled into view is judged by where the sensitive part actually sits.
          for (const needle of needles) {
            for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
              const range = document.createRange();
              range.setStart(node, at);
              range.setEnd(node, at + needle.length);
              for (const rect of range.getClientRects()) {
                let box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
                for (let element = node.parentElement; element && box; element = element.parentElement) {
                  const style = getComputedStyle(element);
                  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) { box = null; break; }
                  if (/(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowX + style.overflowY)) {
                    const clip = element.getBoundingClientRect();
                    box = { left: Math.max(box.left, clip.left), top: Math.max(box.top, clip.top), right: Math.min(box.right, clip.right), bottom: Math.min(box.bottom, clip.bottom) };
                  }
                  if (box.right <= box.left || box.bottom <= box.top) box = null;
                }
                if (box && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight) return `visible text: ${node.nodeValue.slice(Math.max(0, at - 20), at + 60)}`;
              }
            }
          }
        }
        return null;
      }, [demoRoot, sensitiveNeedles]).catch(() => null);
      if (found && !watched.tainted) {
        watched.tainted = found;
        watched.taintedAt = clock();
      }
    }, 200);
    await client.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: sourceSize().width, maxHeight: sourceSize().height, everyNthFrame: 1 });
    await waitFor(() => rec.firstWall, 10_000, "Screencast did not start.");
    mark("start");
  };
  const end = async (extra = {}) => {
    mark("end");
    await page.waitForTimeout(120);
    await client.send("Page.stopScreencast");
    const done = rec;
    done.stopped = true;
    clearInterval(done.watchdog);
    rec = null;
    await done.writes;
    if (done.tainted) {
      await fs.rm(done.frameDir, { recursive: true, force: true });
      throw new Error(`${done.id}: private content reached the screen (${JSON.stringify(done.tainted)} at ${done.taintedAt} s); the recording was discarded.`);
    }
    const concat = [];
    for (let index = 0; index < done.frames.length; index += 1) {
      const next = done.frames[index + 1]?.seconds ?? done.frames[index].seconds + 1 / FPS;
      concat.push(`file '${done.frames[index].file.replaceAll("\\", "/")}'`);
      concat.push(`duration ${Math.max(0.001, next - done.frames[index].seconds).toFixed(6)}`);
    }
    concat.push(`file '${done.frames.at(-1).file.replaceAll("\\", "/")}'`);
    const listPath = path.join(captureDir, `${done.id}-frames.txt`);
    await fs.writeFile(listPath, `${concat.join("\n")}\n`);
    const output = path.join(captureDir, `${done.id}.mp4`);
    await run(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath,
      "-vf", `fps=${FPS},scale=${sourceSize().width}:${sourceSize().height}:flags=lanczos,format=yuv420p`,
      "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-profile:v", "high", "-movflags", "+faststart", output
    ]);
    const duration = done.frames.at(-1).seconds;
    manifest.clips[done.id] = {
      capturedAt: new Date().toISOString(),
      source: path.relative(workDir, output).replaceAll("\\", "/"),
      durationSeconds: Number(duration.toFixed(3)),
      sourceFrames: done.frames.length,
      viewport: `${viewport.width}x${viewport.height}@${viewport.scale}`,
      resolution: `${sourceSize().width}x${sourceSize().height}`,
      markers: done.markers,
      keys: done.keys,
      rects: done.rects,
      texts: done.texts,
      ...extra
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.rm(done.frameDir, { recursive: true, force: true });
    await fs.rm(listPath, { force: true });
    console.log(`${done.id}: ${duration.toFixed(2)} s, ${done.frames.length} frames`);
  };

  // ---- Interaction helpers ----------------------------------------------------------------
  const recordRect = async (id, selector) => {
    const locator = typeof selector === "string" ? page.locator(selector).first() : selector;
    const rect = await locator.boundingBox().catch(() => null);
    if (rec && rect) rec.rects[id] = { seconds: clock(), x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    return rect;
  };
  const recordText = async (id, selector) => {
    const text = await page.locator(selector).first().textContent({ timeout: 2_000 }).catch(() => "");
    if (rec) rec.texts[id] = String(text || "").replace(/\s+/g, " ").trim();
    return rec?.texts[id];
  };
  const cursor = async (visible) => page.evaluate((show) => document.getElementById("demo-cursor")?.classList.toggle("hidden", !show), visible);
  const placeCursor = async (x, y, { instant = false } = {}) => {
    await page.evaluate(([cx, cy, snap]) => {
      const node = document.getElementById("demo-cursor");
      node.classList.toggle("instant", snap);
      node.classList.remove("hidden");
      node.style.left = `${cx}px`;
      node.style.top = `${cy}px`;
    }, [x, y, instant]);
  };
  const moveCursor = async (locator, { dx = 0.5, dy = 0.5, wait = 470 } = {}) => {
    await locator.waitFor({ state: "visible", timeout: 15_000 });
    const box = await locator.boundingBox();
    if (box) await placeCursor(box.x + box.width * dx, box.y + box.height * dy);
    await page.waitForTimeout(wait);
    return box;
  };
  const ring = () => page.evaluate(() => {
    const node = document.getElementById("demo-cursor");
    node?.classList.remove("click");
    void node?.offsetWidth;
    node?.classList.add("click");
  });
  const click = async (target, options = {}) => {
    const locator = typeof target === "string" ? page.locator(target).first() : target;
    await dismissPrompts();
    await moveCursor(locator, options);
    await ring();
    if (options.double) await locator.dblclick();
    else await locator.click({ modifiers: options.modifiers });
    await page.waitForTimeout(options.settle ?? 380);
  };
  // Native <select> popups render outside the page surface, so pick the option directly
  // (the same change event a user selection fires) while the pointer rests on the control.
  const choose = async (target, value, settle = 420) => {
    const locator = typeof target === "string" ? page.locator(target).first() : target;
    await moveCursor(locator);
    await ring();
    await locator.selectOption(value);
    await page.waitForTimeout(settle);
  };
  const press = async (combo, label = combo.replaceAll("+", " + ").replace("Control", "Ctrl")) => {
    rec?.keys.push({ label, seconds: clock() });
    await page.keyboard.press(combo);
  };
  const type = (text, delay = 85) => page.keyboard.type(text, { delay });
  const row = (pane, suffix) => page.locator(`.pane[data-pane="${pane}"] [data-entry-path$="${suffix}"]`).first();
  const leftRow = (suffix) => row("left", suffix);
  const waitRows = (pane) => page.waitForSelector(`.pane[data-pane="${pane}"] [data-entry-path]`, { timeout: 30_000 });
  const openPalette = async (query) => {
    await press("Control+P");
    await page.locator("#command-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(250);
    await type(query, 95);
    await page.waitForTimeout(450);
  };
  const terminalState = (pane, state, timeout) => page.waitForFunction(
    ([name, expected]) => (document.querySelector(`[data-terminal-title="${name}"]`)?.textContent || "").endsWith(`/ ${expected}`),
    [pane, state],
    { timeout }
  );
  const previewVisible = () => page.locator('#inspector [data-panel-action="preview"], [data-panel-action="preview"]').first().getAttribute("aria-pressed").then((value) => value === "true", () => false);
  const setPreview = async (visible) => {
    const button = page.locator('.workspace-panel-button[data-panel-action="preview"]').first();
    const pressed = (await button.getAttribute("aria-pressed").catch(() => null)) === "true";
    if (pressed !== visible) {
      await page.evaluate(() => document.querySelector('.workspace-panel-button[data-panel-action="preview"]')?.click());
      await page.waitForTimeout(400);
    }
  };
  const closeAllDialogs = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const open = await page.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((dialog) => dialog.id));
      if (!open.length) return;
      for (const id of open) {
        const closer = page.locator(`#${id} [data-close-dialog="${id}"]`).first();
        if (await closer.isVisible().catch(() => false)) await closer.click().catch(() => {});
        else await page.evaluate((dialogId) => document.getElementById(dialogId)?.close(), id);
      }
      await page.waitForTimeout(200);
    }
  };
  const closeExtraTabs = async (pane) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const count = await page.locator(`.pane[data-pane="${pane}"] .tab-label[data-tab]`).count();
      if (count <= 1) return;
      await page.locator(`.pane[data-pane="${pane}"] [data-close-tab]`).last().click();
      await page.waitForTimeout(250);
    }
  };
  const setView = async (pane, mode) => {
    const button = page.locator(`[data-view-mode="${mode}"][data-pane="${pane}"]`);
    if ((await button.getAttribute("aria-pressed").catch(() => null)) !== "true") await button.click().catch(() => {});
  };
  const setNavigator = async (visible) => {
    const button = page.locator('.workspace-panel-button[data-panel-action="navigator"]').first();
    const pressed = (await button.getAttribute("aria-pressed").catch(() => null)) === "true";
    if (pressed !== visible) {
      await page.evaluate(() => document.querySelector('[data-panel-action="navigator"]')?.click());
      await page.waitForTimeout(400);
    }
  };
  const setLayout = async (layout) => {
    const code = { vertical: "Digit1", horizontal: "Digit2", single: "Digit3" }[layout];
    await page.locator('.pane[data-pane="left"] [data-entry-path]').first().focus().catch(() => {});
    await page.keyboard.press(`Control+Shift+${code}`).catch(() => {});
    await page.waitForTimeout(300);
  };
  const waitToast = () => page.waitForFunction(() => !document.getElementById("toast")?.classList.contains("show"), null, { timeout: 8_000 }).catch(() => {});
  // Empties the Operations history so each clip's dialog only shows its own work.
  const clearOps = async () => {
    await page.evaluate(() => document.querySelector('[data-topbar-action="ops"]')?.click());
    await page.locator("#ops-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator("[data-clear-operations]").click();
    await page.waitForTimeout(300);
    await page.locator('[data-close-dialog="ops-dialog"]').click();
    await waitToast();
  };
  const reset = async ({ left = fixture.left, right = fixture.right, preview = false, navigator = true, layout = "vertical" } = {}) => {
    await cursor(false);
    await page.keyboard.press("Escape").catch(() => {});
    await closeAllDialogs();
    for (const pane of ["left", "right"]) {
      if (await page.locator(`[data-terminal-drawer="${pane}"]`).isVisible().catch(() => false)) {
        await page.locator(`[data-terminal-action="close"][data-pane="${pane}"]`).click().catch(() => {});
      }
      await closeExtraTabs(pane);
    }
    await setNavigator(navigator);
    await setLayout("vertical");
    await setView("left", "details");
    await setView("right", "details");
    // Reload both folders (right first, so the left pane ends up active) to drop any
    // selection or focus ring left by the previous clip.
    for (const [pane, target] of [["right", right], ["left", left]]) {
      await goTo(pane, target === demoRoot ? fixture.left : demoRoot);
      await goTo(pane, target);
      await waitRows(pane);
    }
    await setPreview(preview);
    if (layout !== "vertical") await setLayout(layout);
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      for (const list of document.querySelectorAll(".pane .file-list, .pane [data-list]")) list.scrollTop = 0;
    });
    await waitToast();
    await page.waitForTimeout(500);
  };

  const clips = {};

  // 1. Two panes, tabs, breadcrumbs, focus and view modes.
  clips["dual-pane"] = async () => {
    await reset();
    await leftRow("README.md").click();
    await page.keyboard.press("Escape");
    await begin("dual-pane");
    await page.waitForTimeout(900);
    await click('[data-new-tab="left"]', { settle: 600 });
    mark("tab-open");
    await click(leftRow("02 Product"), { double: true, settle: 650 });
    await click(leftRow("Renders"), { double: true, settle: 650 });
    await click('[data-view-mode="tiles"][data-pane="left"]', { settle: 900 });
    mark("tiles");
    await click(page.locator('.pane[data-pane="left"] [data-breadcrumb-path]').filter({ hasText: "02 Product" }).first(), { settle: 800 });
    mark("breadcrumb");
    await click(page.locator('.pane[data-pane="left"] .tab-label[data-tab="0"]'), { settle: 800 });
    mark("tab-switch");
    await click(row("right", "Final exports"), { settle: 700 });
    mark("focus-right");
    await click('[data-view-mode="compact"][data-pane="right"]', { settle: 900 });
    await click('[data-view-mode="details"][data-pane="right"]', { settle: 700 });
    await click(leftRow("README.md"), { settle: 500 });
    await cursor(false);
    await page.waitForTimeout(900);
    await end();
  };

  // 2. Per-tab terminal that follows the pane.
  clips.terminal = async () => {
    await reset({ layout: "single" });
    // Warm the PTY off camera so the reveal is immediate, and give the drawer more height.
    await page.locator('[data-terminal-toggle="left"]').click();
    await page.locator('[data-terminal-drawer="left"] .xterm-helper-textarea').waitFor({ state: "attached", timeout: 20_000 });
    await terminalState("left", "Ready", 20_000).catch(() => {});
    const resizer = await page.locator('[data-layout-resize="terminal-left"]').boundingBox();
    if (resizer) {
      await page.mouse.move(resizer.x + resizer.width / 2, resizer.y + resizer.height / 2);
      await page.mouse.down();
      await page.mouse.move(resizer.x + resizer.width / 2, resizer.y - 170, { steps: 10 });
      await page.mouse.up();
    }
    await page.waitForTimeout(800);
    await page.locator('[data-terminal-action="close"][data-pane="left"]').click();
    await leftRow("README.md").click();
    await page.waitForTimeout(600);
    await begin("terminal");
    await page.waitForTimeout(800);
    await press("Control+Backquote", "Ctrl + `");
    const drawer = page.locator('[data-terminal-drawer="left"]');
    await drawer.waitFor({ state: "visible", timeout: 15_000 });
    mark("drawer");
    await page.waitForTimeout(900);
    await recordRect("drawer", drawer);
    await click(leftRow("04 Launch"), { double: true, settle: 1_300 });
    mark("follow");
    const textarea = drawer.locator(".xterm-helper-textarea");
    await textarea.focus();
    await cursor(false);
    await type("Get-ChildItem | Select -First 5", 55);
    await page.waitForTimeout(250);
    await press("Enter");
    mark("run");
    await terminalState("left", "Ready", 15_000).catch(() => {});
    await page.waitForTimeout(2_200);
    await recordRect("drawerEnd", drawer);
    await end();
  };

  // 3. Disk Map: scan, hover, drill in, largest files.
  clips["disk-map"] = async () => {
    await reset();
    await begin("disk-map");
    await page.waitForTimeout(700);
    await click('[data-topbar-action="sizeAnalysis"]', { settle: 300 });
    await page.locator("#size-analysis-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator("#size-analysis-path").fill(fixture.left);
    mark("dialog");
    await page.waitForTimeout(300);
    await click('[data-size-analysis-action="scan"]', { settle: 200 });
    mark("scan");
    await page.waitForFunction(() => {
      const summary = document.querySelector("#size-analysis-summary")?.textContent || "";
      return !/Scanning|Ready/i.test(summary) && Number.parseInt(document.querySelector("#size-analysis-map-count")?.textContent || "0", 10) > 0;
    }, null, { timeout: 30_000 });
    if ((await page.locator("#size-analysis-tab-map").getAttribute("aria-selected")) !== "true") await click("#size-analysis-tab-map", { settle: 300 });
    mark("mapped");
    await recordRect("dialog", "#size-analysis-dialog");
    await recordRect("map", "#size-analysis-treemap");
    await page.waitForTimeout(900);
    const map = await page.locator("#size-analysis-treemap").boundingBox();
    // Hover two file blocks (the detail line names each), then focus the largest folder.
    const glide = async (fx, fy, wait) => {
      const x = map.x + map.width * fx;
      const y = map.y + map.height * fy;
      await placeCursor(x, y);
      await page.mouse.move(x, y, { steps: 8 });
      await page.waitForTimeout(wait);
    };
    await glide(0.3, 0.3, 900);
    mark("hover");
    await glide(0.1, 0.18, 900);
    await glide(0.06, 0.02, 450);
    await ring();
    await page.mouse.click(map.x + map.width * 0.06, map.y + map.height * 0.02);
    await page.waitForTimeout(500);
    await click('[data-size-analysis-map-action="focus"]', { settle: 1_000 });
    mark("drill");
    await recordText("breadcrumbs", "#size-analysis-map-breadcrumbs");
    await glide(0.5, 0.5, 900);
    const files = page.locator("#size-analysis-files");
    await files.scrollIntoViewIfNeeded().catch(() => {});
    await moveCursor(files, { dx: 0.5, dy: 0.2 });
    mark("files");
    await recordRect("files", "#size-analysis-files");
    await cursor(false);
    await page.waitForTimeout(1_600);
    await end();
  };

  // 4. Transfer preview with per-conflict policies, apply, live progress, undo.
  clips.transfer = async () => {
    await reset({ left: fixture.picks, right: fixture.rightPicks });
    await clearOps();
    await leftRow("IMG_4100.jpg").click();
    await begin("transfer");
    await page.waitForTimeout(600);
    await press("Control+A");
    await page.waitForTimeout(450);
    await press("F5");
    await page.locator("#transfer-dialog[open]").waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForFunction(() => {
      const summary = document.querySelector("#transfer-summary")?.textContent || "";
      return !/Previewing/i.test(summary) && document.querySelectorAll("#transfer-results .transfer-row").length > 0;
    }, null, { timeout: 20_000 });
    mark("preview");
    await recordRect("dialog", "#transfer-dialog");
    await page.waitForTimeout(700);
    for (const [name, policy] of [["IMG_4101.jpg", "overwrite"], ["IMG_4102.jpg", "skip"]]) {
      await choose(`#transfer-results [data-transfer-policy$="${name}"]`, policy, 250);
      await page.waitForFunction((expected) => {
        const summary = document.querySelector("#transfer-summary")?.textContent || "";
        return !/Previewing/i.test(summary) && summary.toLowerCase().includes(expected);
      }, policy, { timeout: 15_000 }).catch(() => {});
    }
    mark("policies");
    await recordText("summary", "#transfer-summary");
    await page.waitForTimeout(900);
    await click("#transfer-apply", { settle: 250 });
    mark("apply");
    await click('[data-close-dialog="transfer-dialog"]', { settle: 150 }).catch(() => {});
    await click('[data-topbar-action="ops"]', { settle: 100 });
    await page.locator("#ops-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
    mark("ops");
    await recordRect("ops", "#ops-dialog");
    await cursor(false);
    await page.waitForFunction(() => /completed/i.test(document.querySelector("#operation-list .operation-row .operation-status")?.textContent || ""), null, { timeout: 60_000 });
    mark("complete");
    rec.texts.opsDoneMeta = (await page.locator("#operation-list .operation-row").first().locator(".operation-meta span").allTextContents()).map((item) => item.trim()).join(" / ");
    await page.waitForTimeout(900);
    await click(page.locator("#operation-list [data-undo-operation]").first(), { settle: 300 });
    mark("undo");
    await page.waitForFunction(() => /undone|completed/i.test(document.querySelector("#operation-list .operation-row")?.textContent || "") && (document.querySelector("#operation-list")?.textContent || "").includes("undone"), null, { timeout: 30_000 }).catch(() => {});
    mark("undone");
    await cursor(false);
    await page.waitForTimeout(1_400);
    await end();
  };

  // 5. 100,000 entries.
  clips["large-folder"] = async () => {
    const folder = path.join(fixture.left, "Sensor logs");
    // Generate while neither pane shows the parent folder, then open it on camera.
    await reset({ left: fixture.right, right: fixture.user });
    const started = Date.now();
    await createLargeFolder(folder, 100_000);
    const generatedSeconds = (Date.now() - started) / 1000;
    // Let the file watcher and background index finish with the burst of new files first.
    await page.waitForTimeout(10_000);
    await reset();
    await begin("large-folder");
    await page.waitForTimeout(700);
    await click(leftRow("Sensor logs"), { double: true, settle: 0 });
    mark("open");
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path$="reading-000001.csv"]', { timeout: 30_000 });
    mark("listed");
    await recordText("status", '.dock-status, .pane[data-pane="left"] .pane-status');
    await page.waitForTimeout(900);
    const box = await page.locator('.pane[data-pane="left"] .file-list').boundingBox();
    const at = { x: box.x + box.width * 0.35, y: box.y + box.height * 0.45 };
    await placeCursor(at.x, at.y);
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(500);
    mark("scroll");
    // A flick that accelerates, the way a trackpad or a fast wheel does.
    for (let step = 0; step < 40; step += 1) {
      await page.mouse.wheel(0, Math.round(200 + step * step * 5));
      await page.waitForTimeout(30);
    }
    mark("scrolled");
    await page.waitForTimeout(700);
    await ring();
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(250);
    await press("End");
    mark("end-key");
    await page.waitForTimeout(1_300);
    await cursor(false);
    await end({ generatedSeconds: Number(generatedSeconds.toFixed(1)) });
    await reset();
    await fs.rm(folder, { recursive: true, force: true, maxRetries: 5 });
  };

  // 6. Filtered search: larger than 5 MB, modified in the last 7 days.
  clips.search = async () => {
    await reset();
    await begin("search");
    await page.waitForTimeout(700);
    await click('[data-topbar-action="search"]', { settle: 300 });
    await page.locator("#search-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
    mark("dialog");
    await recordRect("dialog", "#search-dialog");
    await choose("#search-kind", "files", 250);
    await choose("#search-size-op", "greater", 250);
    await click("#search-size-value", { settle: 100 });
    await page.locator("#search-size-value").fill("");
    await type("5 MB", 110);
    await choose("#search-date-op", "newer", 250);
    await click("#search-date-days", { settle: 100 });
    await page.locator("#search-date-days").fill("");
    await type("7", 110);
    mark("filled");
    await click('#search-form button[type="submit"]', { settle: 100 });
    await page.waitForFunction(() => /\d+ match/.test(document.querySelector("#search-summary")?.textContent || ""), null, { timeout: 20_000 });
    mark("results");
    await recordText("summary", "#search-summary");
    await recordRect("results", "#search-results");
    await cursor(false);
    await page.waitForTimeout(1_300);
    await click('[data-close-dialog="search-dialog"]', { settle: 100 });
    mark("pane");
    await cursor(false);
    await page.waitForTimeout(1_800);
    await end();
  };

  // 7. Compare folders and preview a sync plan (never applied).
  clips["compare-sync"] = async () => {
    await reset({ left: path.join(fixture.left, "Website"), right: path.join(fixture.right, "Website") });
    await begin("compare-sync");
    await page.waitForTimeout(700);
    await openPalette("compare");
    await press("Enter");
    await page.locator("#compare-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
    mark("dialog");
    await page.waitForTimeout(500);
    await click('#compare-form button[type="submit"]', { settle: 200 });
    await page.waitForFunction(() => /shown/.test(document.getElementById("compare-summary")?.textContent || "") && document.querySelectorAll("#compare-results .compare-row").length > 2, null, { timeout: 15_000 });
    mark("compared");
    await recordRect("dialog", "#compare-dialog");
    await recordText("compareSummary", "#compare-summary");
    await page.waitForTimeout(1_600);
    await click('[data-compare-action="previewLeftToRight"]', { settle: 200 });
    await page.waitForFunction(() => /planned/.test(document.getElementById("compare-summary")?.textContent || "") && document.querySelectorAll("#sync-preview .sync-preview-row").length > 0, null, { timeout: 15_000 });
    mark("planned");
    await recordText("planSummary", "#compare-summary");
    await recordRect("plan", "#sync-preview");
    await cursor(false);
    await page.waitForTimeout(2_200);
    await end();
  };

  // 8. Preview pane: text, image, PDF, and an interactive STEP model.
  clips.previews = async () => {
    await reset({ preview: true, layout: "single" });
    // With a selection the preview expands; give it more room, the way a user drags the splitter.
    await leftRow("launch-plan.md").click();
    await page.waitForTimeout(700);
    const splitter = await page.locator('[data-layout-resize="inspector"]').boundingBox();
    if (splitter) {
      await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + splitter.height / 2);
      await page.mouse.down();
      await page.mouse.move(splitter.x - 300, splitter.y + splitter.height / 2, { steps: 12 });
      await page.mouse.up();
    }
    await leftRow("launch-plan.md").click();
    await page.waitForTimeout(800);
    await begin("previews");
    await page.waitForTimeout(600);
    await click(leftRow("README.md"), { settle: 1_100 });
    mark("text");
    await click(leftRow("dusk-hero.png"), { settle: 1_200 });
    mark("image");
    await click(leftRow("launch-brief.pdf"), { settle: 1_700 });
    mark("pdf");
    await click(leftRow("bracket-assembly.step"), { settle: 200 });
    await page.waitForFunction(() => document.querySelector('[data-model-viewport="inspector"]')?.dataset.modelState === "ready", null, { timeout: 60_000 });
    mark("model");
    await recordRect("inspector", "#inspector");
    await page.waitForTimeout(500);
    const canvas = await page.locator('[data-model-viewport="inspector"] canvas').boundingBox();
    const cx = canvas.x + canvas.width / 2;
    const cy = canvas.y + canvas.height / 2;
    await placeCursor(cx - 60, cy);
    await page.waitForTimeout(450);
    await page.mouse.move(cx - 60, cy);
    await page.mouse.down();
    mark("orbit");
    for (let step = 0; step <= 40; step += 1) {
      const x = cx - 60 + step * 4;
      const y = cy + Math.sin(step / 40 * Math.PI) * 30;
      await page.mouse.move(x, y);
      await placeCursor(x, y, { instant: true });
      await page.waitForTimeout(33);
    }
    await page.mouse.up();
    await page.waitForTimeout(700);
    await cursor(false);
    await page.waitForTimeout(700);
    await end();
  };

  // 9. Command palette: fuzzy search, run, and back.
  clips["command-palette"] = async () => {
    await reset();
    await begin("command-palette");
    await page.waitForTimeout(800);
    await openPalette("split");
    mark("split");
    await page.waitForTimeout(600);
    await type(" horizontal", 80);
    await page.waitForTimeout(350);
    mark("results");
    await recordRect("palette", "#command-dialog");
    await page.waitForTimeout(500);
    await press("Enter");
    mark("horizontal");
    await page.waitForTimeout(1_600);
    await openPalette("split vertical");
    await page.waitForTimeout(500);
    await press("Enter");
    mark("vertical");
    await page.waitForTimeout(1_200);
    await end();
  };

  // 10. Rename refuses an existing name; a real rename is undone from Operations.
  clips["safe-rename"] = async () => {
    await reset();
    await clearOps();
    await begin("safe-rename");
    await page.waitForTimeout(600);
    await click(leftRow("launch-plan.md"), { settle: 300 });
    await press("F2");
    await page.locator("[data-inline-rename]").waitFor({ state: "visible", timeout: 5_000 });
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+A");
    await type("README.md", 95);
    await page.waitForTimeout(250);
    await press("Enter");
    await page.waitForFunction(() => /already exists/i.test(document.getElementById("toast")?.textContent || ""), null, { timeout: 5_000 });
    mark("refused");
    await recordRect("rename", "[data-inline-rename]");
    await recordRect("toast", "#toast");
    await recordText("toast", "#toast");
    await cursor(false);
    await page.waitForTimeout(1_500);
    await page.keyboard.press("Control+A");
    await type("launch-plan-final.md", 70);
    await press("Enter");
    await leftRow("launch-plan-final.md").waitFor({ state: "visible", timeout: 10_000 });
    mark("renamed");
    await page.waitForTimeout(1_000);
    await click('[data-topbar-action="ops"]', { settle: 200 });
    await page.locator("#ops-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
    mark("ops");
    await recordRect("ops", "#ops-dialog");
    await click(page.locator("#operation-list [data-undo-operation]").first(), { settle: 600 });
    mark("undo");
    await click('[data-close-dialog="ops-dialog"]', { settle: 200 });
    await leftRow("launch-plan.md").waitFor({ state: "visible", timeout: 10_000 });
    mark("restored");
    await recordRect("restoredRow", leftRow("launch-plan.md"));
    await cursor(false);
    await page.waitForTimeout(1_400);
    await end();
  };

  // 11. Keyboard-first: focus ring, Shift+F10 menu, arrows, Enter.
  clips.keyboard = async () => {
    await reset();
    await leftRow("01 Brand").click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const inList = await page.evaluate(() => Boolean(document.activeElement?.closest('.pane[data-pane="left"]')));
    if (!inList) throw new Error("Keyboard clip: focus is not in the left file list.");
    await begin("keyboard");
    await page.waitForTimeout(600);
    for (let step = 0; step < 8; step += 1) {
      await press("ArrowDown", "↓");
      await page.waitForTimeout(300);
    }
    mark("focused");
    await page.waitForTimeout(300);
    await press("Shift+F10", "Shift + F10");
    await page.locator("#context-menu:not([hidden])").waitFor({ state: "visible", timeout: 5_000 });
    mark("menu");
    await recordRect("menu", "#context-menu");
    // Walk down to "Create Checksums" (never Reveal In Explorer, which would open a
    // window outside the capture).
    for (let step = 0; step < 12; step += 1) {
      const focused = (await page.locator("#context-menu :focus").textContent().catch(() => "")) || "";
      if (/Create Checksums/i.test(focused)) break;
      await page.waitForTimeout(300);
      await press("ArrowDown", "↓");
    }
    await page.waitForTimeout(500);
    const item = await recordText("menuItem", "#context-menu :focus");
    if (!/Create Checksums/i.test(item || "")) throw new Error(`Keyboard menu stopped on "${item}", not Create Checksums.`);
    await press("Enter");
    mark("enter");
    await page.locator("#checksums-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
    await recordRect("checksums", "#checksums-dialog");
    await page.waitForTimeout(1_800);
    await press("Escape", "Esc");
    await page.waitForTimeout(900);
    await end();
  };

  // 12. A real MCP client run against the read-only profile.
  let aiEvents = [];
  clips["ai-handoff"] = async () => {
    await reset();
    await leftRow("README.md").click();
    await page.waitForTimeout(500);
    const sidecar = existsSync(path.join(localAppData, "ExploreBetter", "MCP", "bin", "ExploreBetterMcp.exe"))
      ? path.join(localAppData, "ExploreBetter", "MCP", "bin", "ExploreBetterMcp.exe")
      : repoSidecar;
    await fs.access(sidecar);
    await begin("ai-handoff");
    await page.waitForTimeout(900);
    mark("ask");
    const toolEvents = [];
    const onTool = (tool, phase, item) => {
      mark(`${tool.replaceAll("_", "-")}-${phase}`);
      toolEvents.push({ tool, phase, seconds: rec.markers.at(-1).seconds, ...(phase === "complete" ? summarizeCall(item) : {}) });
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
    mark("revealed");
    await recordRect("leftPane", '.pane[data-pane="left"]');
    await page.waitForTimeout(2_000);
    aiEvents = toolEvents;
    await fs.writeFile(path.join(captureDir, "ai-handoff-trace.json"), `${JSON.stringify({ client: handoff.client, codexFallbackReason: codexError, prompt: aiPrompt(fixture.left), events: toolEvents, trace: handoff.trace }, null, 2)}\n`);
    await end({ aiClient: handoff.client, aiEvents: toolEvents, codexFallbackReason: codexError });
  };

  // 13. AI Bridge preferences: scoped read-only profile, tool permissions, audit log.
  clips["ai-profile"] = async () => {
    await reset();
    // Off camera: make sure the settings search starts empty.
    await page.evaluate(() => document.querySelector('[data-global-action="preferences"]')?.click());
    await page.locator("#preferences-dialog[open]").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator("#preferences-search").fill("");
    await page.locator("#preferences-search").press("Enter").catch(() => {});
    await page.evaluate(() => {
      for (const details of document.querySelectorAll(".ai-bridge-audit, .ai-bridge-permissions")) details.open = false;
      document.querySelector("#preferences-dialog .preferences-body, #preferences-dialog form")?.scrollTo?.(0, 0);
    });
    await page.waitForTimeout(300);
    await closeAllDialogs();
    await page.waitForTimeout(400);
    await begin("ai-profile");
    await page.waitForTimeout(600);
    await openPalette("preferences");
    await press("Enter");
    await page.locator("#preferences-dialog[open]").waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForFunction(() => {
      const profileCount = document.querySelector("#preference-ai-profile")?.options.length || 0;
      const toolCount = document.querySelectorAll("#preference-ai-tools input").length;
      return Boolean(window.exploreBetterDesktop?.aiBridge) && profileCount > 0 && toolCount > 0;
    }, null, { timeout: 20_000 });
    await page.waitForTimeout(600);
    // Settings search narrows the AI Bridge section to what matters here, and keeps the
    // unpackaged dev build's client snippet (which contains repository paths) out of frame.
    await click("#preferences-search", { settle: 150 });
    await type("authorized", 90);
    await page.locator("#preference-ai-roots").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(400);
    mark("profile");
    await recordRect("section", ".ai-bridge-preferences");
    await moveCursor(page.locator("#preference-ai-roots"), { wait: 1_000 });
    await click(".ai-bridge-permissions summary", { settle: 700 });
    mark("tools");
    await recordRect("tools", ".ai-bridge-permissions");
    await cursor(false);
    await page.waitForTimeout(1_800);
    // Replace the query in one step: partial queries ("a", "au") briefly match the whole
    // section, which would scroll the snippet into view.
    await moveCursor(page.locator("#preferences-search"), { wait: 300 });
    await ring();
    await page.locator("#preferences-search").fill("audit");
    await page.waitForTimeout(500);
    const audit = page.locator(".ai-bridge-audit summary");
    await audit.waitFor({ state: "visible", timeout: 10_000 });
    await click(audit, { settle: 500 });
    if (await page.locator("#preference-ai-snippet").isVisible().catch(() => false)) throw new Error("The AI Bridge client snippet is visible; it would show repository paths.");
    mark("audit");
    await recordRect("audit", ".ai-bridge-audit");
    await cursor(false);
    await page.waitForTimeout(2_200);
    await end();
  };

  for (const id of selected) {
    console.log(`Recording ${id}`);
    await clips[id]();
  }
  await reset().catch(() => {});
  console.log(JSON.stringify({ clips: Object.keys(manifest.clips), manifest: path.relative(root, manifestPath) }, null, 2));
} catch (error) {
  throw new Error(`${error.stack || error.message}\n${logs.slice(-4000)}`);
} finally {
  await browser?.close().catch(() => {});
  if (app && app.exitCode === null) spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  if (!attachPort) {
    await sleep(800);
    if (existsSync(markerFile)) await fs.rm(demoRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch((error) => console.warn(`Could not remove ${demoRoot}: ${error.message}`));
  }
}
