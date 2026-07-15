import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { chromium } from "playwright-core";

const root = process.cwd();
const workDir = path.join(root, "demo-video-v2");
const captureDir = path.join(workDir, "capture");
const frameDir = path.join(captureDir, "frames");
const outputPath = path.join(captureDir, "explore-better-live-walkthrough.mp4");
const codexTracePath = path.join(captureDir, "codex-handoff-trace.json");
const electronApp = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";

async function findCodexCli() {
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  const binRoot = path.join(os.homedir(), "AppData", "Local", "OpenAI", "Codex", "bin");
  const candidates = [];
  for (const entry of await fs.readdir(binRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const executable = path.join(binRoot, entry.name, "codex.exe");
    try {
      const stat = await fs.stat(executable);
      candidates.push({ executable, modified: stat.mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.modified - a.modified);
  if (!candidates.length) throw new Error("Codex CLI was not found for the live AI Bridge capture.");
  return candidates[0].executable;
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

async function waitForCdp(port, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Explore Better exited before CDP was ready (${child.exitCode}).`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Timed out waiting for Explore Better.");
}

async function waitForRenderer(browser) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith("http://127.0.0.1"));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Explore Better renderer was not available through CDP.");
}

async function dismissDefaultExplorerPrompt(page) {
  const dialog = page.locator("#default-explorer-dialog");
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.locator('[data-default-explorer-choice="keep"]').click();
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  }
}

async function createFixture(base) {
  const left = path.join(base, "Project files");
  const right = path.join(base, "Release ready");
  const folders = [
    path.join(left, "01 Brand"),
    path.join(left, "02 Product"),
    path.join(left, "03 Research"),
    path.join(left, "04 Launch"),
    path.join(left, "Archive"),
    path.join(right, "Approved"),
    path.join(right, "Final exports")
  ];
  await Promise.all(folders.map((folder) => fs.mkdir(folder, { recursive: true })));
  const files = [
    [path.join(left, "README.md"), "# Explore Better launch workspace\n\nSource assets, product research, and release planning for the Windows file manager built for humans and AI.\n"],
    [path.join(left, "launch-plan.md"), "Explore Better launch plan\nWindows 11\nLocal-first\nHuman + AI\n"],
    [path.join(left, "invoice-july.pdf"), Buffer.alloc(1_400_000, 0x45)],
    [path.join(left, "invoice-june.pdf"), Buffer.alloc(920_000, 0x42)],
    [path.join(left, "interface-notes.txt"), "Dual panes. Fast search. Recoverable operations.\n"],
    [path.join(left, "01 Brand", "explore-better-logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="240"><rect width="100%" height="100%" fill="#111715"/><text x="44" y="150" fill="#c7ff4a" font-size="84">Explore Better</text></svg>'],
    [path.join(left, "02 Product", "workspace-tour.mp4"), Buffer.alloc(8_600_000, 0x19)],
    [path.join(left, "02 Product", "ai-bridge-demo.mp4"), Buffer.alloc(6_100_000, 0x27)],
    [path.join(left, "03 Research", "search-benchmark.csv"), "tool,median_ms\nExplore Better MCP,9.8\nPowerShell,536.1\n"],
    [path.join(left, "03 Research", "customer-interviews.docx"), Buffer.alloc(2_200_000, 0x51)],
    [path.join(left, "04 Launch", "press-kit.zip"), Buffer.alloc(4_400_000, 0x76)],
    [path.join(left, "04 Launch", "release-checklist.md"), "[x] checksums\n[x] signed artifacts\n[x] update feed\n"],
    [path.join(left, "Archive", "explore-better-v1.exe"), Buffer.alloc(11_400_000, 0x31)],
    [path.join(right, "interface-notes.txt"), "Previous release notes.\n"],
    [path.join(right, "Approved", "release-notes.md"), "Fast. Local-first. Visible. Recoverable.\n"],
    [path.join(right, "Final exports", "ExploreBetter-0.2.0-x64.exe"), Buffer.alloc(14_200_000, 0x63)]
  ];
  for (const [file, contents] of files) await fs.writeFile(file, contents);
  return { left, right };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with ${code}`)));
  });
}

async function runCodexHandoff({ codex, sidecar, localAppData, fixtureRoot, onEvent }) {
  const prompt = [
    "Use only the explore-better MCP server. Do not use shell, GitNexus, browser, or any other tool.",
    "Call get_context so you can see the live active pane.",
    `Then call search_files with path ${fixtureRoot}, query README.md, kind files, and limit 10; omit maxScanned.`,
    "Choose the README.md at the root of Project files and call show_in_explore_better for that exact path in the active pane.",
    "Finish with exactly: Found the launch README and revealed it in your active Explore Better pane."
  ].join(" ");
  const args = [
    "exec", "--ephemeral", "--json", "--color", "never", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", fixtureRoot,
    "-c", `mcp_servers.explore-better.command=${JSON.stringify(sidecar)}`,
    "-c", `mcp_servers.explore-better.args=${JSON.stringify(["--profile", "demo-readonly", "--app", electronApp, "--app-dir", root])}`,
    "-c", `mcp_servers.explore-better.env={LOCALAPPDATA=${JSON.stringify(localAppData)}}`,
    prompt
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(codex, args, {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
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
          onEvent(event);
        } catch {}
      }
      if (flush && stdout.trim().startsWith("{")) {
        try {
          const event = JSON.parse(stdout);
          trace.push(event);
          onEvent(event);
        } catch {}
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      consume();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => {
      consume(true);
      if (code === 0) resolve({ trace, stderr });
      else reject(new Error(`Codex handoff exited with ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

await fs.access(electronApp);
await fs.rm(captureDir, { recursive: true, force: true });
await fs.mkdir(frameDir, { recursive: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "explore-better-demo-v2-"));
const localAppData = path.join(temp, "LocalAppData");
const userData = path.join(temp, "Electron");
const fixture = await createFixture(path.join(temp, "Demo workspace"));
const codex = await findCodexCli();
const sidecar = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ExploreBetter", "MCP", "bin", "ExploreBetterMcp.exe");
await fs.access(sidecar);
await fs.mkdir(path.join(localAppData, "ExploreBetter", "MCP"), { recursive: true });
await fs.writeFile(
  path.join(localAppData, "ExploreBetter", "MCP", "bridge-config.json"),
  `${JSON.stringify({
    version: 1,
    enabled: true,
    auditRetentionDays: 30,
    profiles: [{
      id: "demo-readonly",
      name: "Codex - Project Read Only",
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastConnectedAt: null
    }],
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`,
  "utf8"
);

const port = await freePort();
const app = spawn(electronApp, [root, fixture.left, "--no-updates", `--remote-debugging-port=${port}`], {
  cwd: root,
  env: {
    ...process.env,
    LOCALAPPDATA: localAppData,
    EXPLORE_BETTER_USER_DATA_DIR: userData,
    EXPLORE_BETTER_UPDATE_URL: "",
    EXPLORE_BETTER_DISABLE_GPU: "1"
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
let frameCount = 0;
let startTime = 0;
const markers = [];
const mark = (id) => markers.push({ id, seconds: Number(((Date.now() - startTime) / 1000).toFixed(3)) });

try {
  await waitForCdp(port, app);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await waitForRenderer(browser);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 30_000 });
  await page.locator('[data-path-input="right"]').fill(fixture.right);
  await page.locator('[data-path-input="right"]').press("Enter");
  await page.waitForSelector('.pane[data-pane="right"] [data-entry-path]', { timeout: 30_000 });
  await page.waitForFunction((expected) => document.querySelector('[data-path-input="right"]')?.value === expected, fixture.right, { timeout: 15_000 });
  await dismissDefaultExplorerPrompt(page);
  await page.waitForTimeout(1_000);

  // Warm the PTY before recording so the terminal reveal is immediate in the hero take.
  await page.locator('[data-terminal-toggle="left"]').click();
  await page.locator('[data-terminal-drawer="left"] .xterm-helper-textarea').waitFor({ state: "attached", timeout: 20_000 });
  await page.locator('[data-terminal-action="close"][data-pane="left"]').click();
  await page.waitForTimeout(500);

  // Keep the page repainting at 30 fps and add a restrained lime demo cursor.
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      #demo-cursor { position:fixed; z-index:2147483647; width:18px; height:18px; border:2px solid #111715; border-radius:50%; background:#c7ff4a; pointer-events:none; transform:translate(-50%,-50%); box-shadow:0 2px 10px rgba(17,23,21,.35); transition:left .48s cubic-bezier(.2,.9,.25,1), top .48s cubic-bezier(.2,.9,.25,1); }
      #demo-cursor.click::after { content:""; position:absolute; inset:-9px; border:2px solid #c7ff4a; border-radius:50%; animation:demo-ring .42s ease-out both; }
      #demo-heartbeat { position:fixed; left:0; top:0; width:2px; height:2px; opacity:.01; background:#c7ff4a; pointer-events:none; }
      @keyframes demo-ring { from { transform:scale(.2); opacity:1; } to { transform:scale(1.55); opacity:0; } }
    `;
    document.head.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.style.left = "720px";
    cursor.style.top = "450px";
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

  const moveCursor = async (selector) => {
    await page.locator(selector).first().waitFor({ state: "visible", timeout: 15_000 });
    await page.evaluate((targetSelector) => {
      const target = document.querySelector(targetSelector);
      const cursor = document.getElementById("demo-cursor");
      if (!target || !cursor) return;
      const rect = target.getBoundingClientRect();
      cursor.style.left = `${rect.left + rect.width / 2}px`;
      cursor.style.top = `${rect.top + rect.height / 2}px`;
    }, selector);
    await page.waitForTimeout(540);
  };
  const click = async (selector) => {
    await dismissDefaultExplorerPrompt(page);
    await moveCursor(selector);
    await dismissDefaultExplorerPrompt(page);
    await page.evaluate(() => {
      const cursor = document.getElementById("demo-cursor");
      cursor?.classList.remove("click");
      void cursor?.offsetWidth;
      cursor?.classList.add("click");
    });
    await page.locator(selector).first().click();
    await page.waitForTimeout(430);
  };

  client = await page.context().newCDPSession(page);
  client.on("Page.screencastFrame", async ({ data, sessionId }) => {
    const index = frameCount++;
    client.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    const target = path.join(frameDir, `frame-${String(index).padStart(6, "0")}.jpg`);
    writeQueue = writeQueue.then(() => fs.writeFile(target, Buffer.from(data, "base64")));
  });
  startTime = Date.now();
  await client.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1600, maxHeight: 900, everyNthFrame: 1 });

  mark("workspace");
  await page.waitForTimeout(2_300);
  await dismissDefaultExplorerPrompt(page);

  mark("live-filter");
  await click('[data-filter="left"]');
  await page.keyboard.type("invoice", { delay: 125 });
  await page.waitForTimeout(1_550);
  await page.locator('[data-filter="left"]').press("Control+A");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(850);

  mark("command-center");
  await page.keyboard.press("Control+P");
  await page.locator("#command-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
  await page.keyboard.type("disk map", { delay: 130 });
  await page.waitForTimeout(1_650);
  await page.keyboard.press("Enter");
  await page.locator("#size-analysis-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(900);

  mark("disk-map");
  await click('[data-size-analysis-action="scan"]');
  await page.waitForFunction(() => {
    const text = document.querySelector("#size-analysis-summary")?.textContent || "";
    return !/Scanning/i.test(text) && document.querySelectorAll("#size-analysis-files .size-analysis-row").length > 0;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(1_250);
  await click('[data-size-analysis-action="view-map"]');
  await page.waitForTimeout(2_300);
  await click('[data-close-dialog="size-analysis-dialog"]');
  await page.waitForTimeout(850);

  mark("operation-preview");
  await click('.pane[data-pane="left"] [data-entry-path$="interface-notes.txt"]');
  await page.keyboard.press("Control+P");
  await page.locator("#command-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
  await page.keyboard.type("transfer selected", { delay: 95 });
  await page.waitForTimeout(750);
  const transferCommand = page.locator("[data-palette-index]").filter({ hasText: "Transfer selected with policy" }).first();
  await transferCommand.waitFor({ state: "visible", timeout: 10_000 });
  await transferCommand.click();
  await page.locator("#transfer-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(() => {
    const summary = document.querySelector("#transfer-summary")?.textContent || "";
    return !/Previewing/i.test(summary) && document.querySelectorAll("#transfer-results .transfer-row").length > 0;
  }, null, { timeout: 15_000 });
  await page.waitForTimeout(3_200);
  await click('[data-close-dialog="transfer-dialog"]');
  await page.waitForTimeout(700);

  mark("terminal");
  await click('[data-terminal-toggle="left"]');
  const terminal = page.locator('[data-terminal-drawer="left"]');
  await terminal.waitFor({ state: "visible", timeout: 15_000 });
  const textarea = terminal.locator(".xterm-helper-textarea");
  await textarea.waitFor({ state: "attached", timeout: 15_000 });
  await textarea.focus();
  await page.keyboard.type("Write-Host 'Same folder. Zero setup.'; Get-Location", { delay: 58 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(4_200);
  await click('[data-terminal-action="close"][data-pane="left"]');
  await page.waitForTimeout(800);

  mark("codex-handoff");
  const codexEvents = [];
  const codexResult = await runCodexHandoff({
    codex,
    sidecar,
    localAppData,
    fixtureRoot: fixture.left,
    onEvent: (event) => {
      const tool = event?.item?.type === "mcp_tool_call" ? event.item.tool : "";
      const phase = event.type === "item.started" ? "start" : event.type === "item.completed" ? "complete" : "";
      if (tool && phase) {
        const marker = `codex-${tool.replaceAll("_", "-")}-${phase}`;
        mark(marker);
        codexEvents.push({ marker, seconds: markers.at(-1).seconds, status: event.item.status || "" });
      }
    }
  });
  await fs.writeFile(codexTracePath, `${JSON.stringify({ events: codexEvents, trace: codexResult.trace, stderr: codexResult.stderr }, null, 2)}\n`, "utf8");
  await page.waitForTimeout(2_200);

  mark("ai-bridge");
  await page.keyboard.press("Control+P");
  await page.locator("#command-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
  await page.keyboard.type("preferences", { delay: 95 });
  await page.waitForTimeout(850);
  await page.keyboard.press("Enter");
  await page.locator("#preferences-dialog[open]").waitFor({ state: "visible", timeout: 15_000 });
  await page.evaluate(() => document.querySelector(".ai-bridge-preferences")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  await page.locator(".ai-bridge-preferences").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => {
    const profileCount = document.querySelector("#preference-ai-profile")?.options.length || 0;
    const toolCount = document.querySelectorAll("#preference-ai-tools input").length;
    return Boolean(window.exploreBetterDesktop?.aiBridge) && profileCount > 0 && toolCount > 0;
  }, null, { timeout: 20_000 });
  await page.waitForTimeout(4_250);

  mark("proof-hold");
  await page.waitForTimeout(4_500);
  mark("end");

  await client.send("Page.stopScreencast");
  await page.evaluate(() => clearInterval(window.__demoHeartbeat));
  await writeQueue;
  const duration = (Date.now() - startTime) / 1000;
  const sourceRate = frameCount / duration;
  await run(ffmpeg, [
    "-y", "-framerate", sourceRate.toFixed(6), "-i", path.join(frameDir, "frame-%06d.jpg"),
    "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "17",
    "-profile:v", "high", "-level", "4.1", "-movflags", "+faststart", outputPath
  ]);
  const manifest = {
    capturedAt: new Date().toISOString(),
    durationSeconds: Number(duration.toFixed(3)),
    sourceFrames: frameCount,
    sourceRate: Number(sourceRate.toFixed(3)),
    outputFrameRate: 30,
    resolution: "1600x900",
    markers,
    output: path.relative(root, outputPath),
    codexTrace: path.relative(root, codexTracePath)
  };
  await fs.writeFile(path.join(captureDir, "capture-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
} catch (error) {
  throw new Error(`${error.message}\n${logs.slice(-5000)}`);
} finally {
  await browser?.close().catch(() => {});
  if (app.exitCode === null) spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
