// Captures the marketing screenshots in site/assets from the real desktop app.
// The app runs in dev mode (never the packaged exe) against a disposable
// fixture workspace with redirected app data and home folders, so nothing on
// the capturing machine is shown, installed, registered, or changed.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { chromium } from "playwright-core";

const root = process.cwd();
const electronApp = path.join(root, "node_modules", "electron", "dist", "electron.exe");
// EXPLORE_BETTER_CAPTURE_OUT lets a trial run write somewhere other than site/assets.
const siteAssets = path.resolve(process.env.EXPLORE_BETTER_CAPTURE_OUT || path.join(root, "site", "assets"));
const viewport = { width: 1440, height: 900 };
const requiredRendererFiles = ["app-runtime.js", "terminal-renderer.js"].map((name) => path.join(root, "public", "generated", name));

for (const required of [electronApp, ...requiredRendererFiles]) {
  if (!existsSync(required)) {
    const hint = required === electronApp ? "Run npm install first." : "Run npm run build:renderer first.";
    console.error(`Missing ${path.relative(root, required)}. ${hint}`);
    process.exit(1);
  }
}

// App data and the fixture home live in two disposable folders that are deleted afterwards.
// The home path shows in the address bar and terminal, so published captures should set
// EXPLORE_BETTER_CAPTURE_HOME to a short folder that does not exist yet (for example C:\Demo);
// otherwise it is a random folder under EXPLORE_BETTER_CAPTURE_ROOT or the temp directory.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "eb-site-"));
const userData = path.join(temp, "Electron");
let home;
if (process.env.EXPLORE_BETTER_CAPTURE_HOME) {
  home = path.resolve(process.env.EXPLORE_BETTER_CAPTURE_HOME);
  if (existsSync(home)) {
    console.error(`EXPLORE_BETTER_CAPTURE_HOME ${home} already exists; choose a folder the capture can create and delete.`);
    await fs.rm(temp, { recursive: true, force: true });
    process.exit(1);
  }
  await fs.mkdir(home, { recursive: true });
} else {
  home = await fs.mkdtemp(path.join(process.env.EXPLORE_BETTER_CAPTURE_ROOT || os.tmpdir(), "Demo-"));
}
// App data paths are visible in the AI Bridge settings (the MCP server path), so keep
// them under the fixture home rather than the real temp folder, which names the user.
const localAppData = path.join(home, "AppData", "Local");

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
    } catch {
      // The debugger endpoint is not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Timed out waiting for the Explore Better debugger endpoint.");
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

// Always answer the first-run default-explorer prompt with "keep": capturing
// must never make Explore Better the default or touch shell integration.
async function dismissDefaultExplorerPrompt(page) {
  const dialog = page.locator("#default-explorer-dialog");
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.locator('[data-default-explorer-choice="keep"]').click();
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    return true;
  }
  return false;
}

// A small but valid PNG (soft diagonal gradient), padded to a realistic size so
// image files decode for thumbnails and still weigh something in the Disk Map.
function gradientPng(width, height, [r1, g1, b1], [r2, g2, b2], padTo = 0) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const t = (x / width + y / height) / 2;
      raw[row + 1 + x * 3] = Math.round(r1 + (r2 - r1) * t);
      raw[row + 2 + x * 3] = Math.round(g1 + (g2 - g1) * t);
      raw[row + 3 + x * 3] = Math.round(b1 + (b2 - b1) * t);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
  return padTo > png.length ? Buffer.concat([png, Buffer.alloc(Math.round(padTo) - png.length)]) : png;
}

const MB = 1024 * 1024;
const blob = (megabytes, fill) => Buffer.alloc(Math.round(megabytes * MB), fill);

async function createFixture() {
  const left = path.join(home, "Project files");
  const right = path.join(home, "Release ready");
  const text = {
    readme: "# Spring launch workspace\n\nSource assets, research, and release planning for the spring product launch.\n\n- 01 Brand: logos, palette, guidelines\n- 02 Product: screens and walkthrough videos\n- 03 Research: survey data and interview notes\n- 04 Launch: press kit, timeline, checklist\n",
    plan: "# Launch plan\n\n1. Freeze copy and screenshots\n2. Export final videos\n3. Publish release notes\n4. Send press kit\n",
    oldPlan: "# Launch plan (draft)\n\n1. Collect assets\n2. Review copy\n",
    notes: "Weekly sync\n- Final exports due Friday\n- Press kit review with design\n- Confirm launch timeline\n"
  };
  const files = [
    // Left pane: the active project folder.
    ["Project files/README.md", text.readme],
    ["Project files/launch-plan.md", text.plan],
    ["Project files/meeting-notes.txt", text.notes],
    ["Project files/roadmap-2026.pdf", blob(2.1, 0x21)],
    ["Project files/budget-2026.xlsx", blob(0.34, 0x22)],
    ["Project files/team-photo.png", gradientPng(640, 400, [58, 84, 74], [199, 255, 74], 3.6 * MB)],
    ["Project files/01 Brand/logo-primary.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200"><rect width="100%" height="100%" rx="24" fill="#111715"/><circle cx="100" cy="100" r="54" fill="#c7ff4a"/><text x="184" y="124" fill="#f4f7f2" font-family="Segoe UI" font-size="64">Spring Launch</text></svg>\n'],
    ["Project files/01 Brand/logo-mono.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200"><circle cx="100" cy="100" r="54" fill="#111715"/><text x="184" y="124" fill="#111715" font-family="Segoe UI" font-size="64">Spring Launch</text></svg>\n'],
    ["Project files/01 Brand/brand-guidelines.pdf", blob(6.8, 0x31)],
    ["Project files/01 Brand/color-palette.pdf", blob(1.2, 0x32)],
    ["Project files/01 Brand/typography-specimen.png", gradientPng(640, 400, [244, 247, 242], [120, 140, 132], 2.4 * MB)],
    ["Project files/02 Product/workspace-tour.mp4", blob(48, 0x41)],
    ["Project files/02 Product/onboarding-walkthrough.mp4", blob(31, 0x42)],
    ["Project files/02 Product/feature-matrix.xlsx", blob(0.42, 0x43)],
    ["Project files/02 Product/UI screens/dashboard.png", gradientPng(640, 400, [17, 23, 21], [66, 98, 86], 2.9 * MB)],
    ["Project files/02 Product/UI screens/settings.png", gradientPng(640, 400, [30, 40, 60], [110, 150, 200], 1.8 * MB)],
    ["Project files/02 Product/UI screens/search-results.png", gradientPng(640, 400, [60, 30, 40], [220, 140, 120], 2.2 * MB)],
    ["Project files/02 Product/UI screens/onboarding.png", gradientPng(640, 400, [40, 60, 30], [180, 220, 110], 1.5 * MB)],
    ["Project files/03 Research/survey-results-2026.csv", `respondent,segment,score\n${Array.from({ length: 4000 }, (_, i) => `${1000 + i},${["design", "engineering", "ops", "sales"][i % 4]},${(i * 7) % 10}`).join("\n")}\n`],
    ["Project files/03 Research/benchmark-results.csv", "task,median_ms,p95_ms\nopen folder,38,71\nsearch,112,240\ncopy 1 GB,5400,6100\n"],
    ["Project files/03 Research/interview-notes.md", "# Interview notes\n\n- Wants faster search across project folders\n- Uses two windows side by side for every copy\n- Needs to see what a move will overwrite first\n"],
    ["Project files/03 Research/usability-sessions.zip", blob(22, 0x51)],
    ["Project files/03 Research/competitive-review.pdf", blob(3.4, 0x52)],
    ["Project files/04 Launch/press-kit.zip", blob(18, 0x61)],
    ["Project files/04 Launch/launch-timeline.pdf", blob(0.9, 0x62)],
    ["Project files/04 Launch/release-checklist.md", "- [x] Final screenshots\n- [x] Release notes\n- [ ] Press kit sent\n- [ ] Social posts scheduled\n"],
    ["Project files/04 Launch/Social/banner-1200x630.png", gradientPng(600, 315, [199, 255, 74], [17, 23, 21], 1.1 * MB)],
    ["Project files/04 Launch/Social/square-1080.png", gradientPng(540, 540, [17, 23, 21], [199, 255, 74], 1.4 * MB)],
    ["Project files/Archive/2025-campaign-assets.zip", blob(64, 0x71)],
    ["Project files/Archive/website-backup-2025.zip", blob(27, 0x72)],
    ["Project files/Archive/q3-review-deck.pptx", blob(12, 0x73)],
    // Right pane: the release hand-off folder, with deliberate overlaps so the
    // transfer preview has real conflicts to resolve.
    ["Release ready/launch-plan.md", text.oldPlan],
    ["Release ready/meeting-notes.txt", text.notes],
    ["Release ready/roadmap-2026.pdf", blob(1.7, 0x23)],
    ["Release ready/Approved/release-notes.md", "# Release notes\n\nFaster search, clearer transfers, and a new disk map.\n"],
    ["Release ready/Approved/press-release.pdf", blob(0.6, 0x81)],
    ["Release ready/Final exports/product-overview.pdf", blob(4.2, 0x82)],
    ["Release ready/Final exports/hero-banner.png", gradientPng(640, 360, [17, 23, 21], [199, 255, 74], 3.1 * MB)],
    ["Release ready/Final exports/launch-video-1080p.mp4", blob(72, 0x83)],
    // Home shortcuts, so the Navigator's Home, Desktop, Documents, and
    // Downloads entries resolve inside the fixture.
    ["Desktop/todo.txt", "Review final exports\n"],
    ["Documents/Notes/ideas.md", "# Ideas\n"],
    ["Downloads/sample-dataset.csv", "id,value\n1,42\n"],
    ["Pictures/wallpaper.png", gradientPng(640, 360, [30, 60, 50], [199, 255, 74])],
    ["Music/.keep", ""],
    ["Videos/.keep", ""],
    // Shells resolve Local/Roaming AppData from USERPROFILE; without these
    // folders Windows PowerShell writes its module cache into the cwd.
    ["AppData/Roaming/.keep", ""],
    ["AppData/Local/.keep", ""]
  ];
  for (const [relative, contents] of files) {
    const target = path.join(home, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
  // Older timestamps on the right-hand copies make the conflicts read naturally.
  const older = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
  for (const name of ["launch-plan.md", "roadmap-2026.pdf"]) await fs.utimes(path.join(right, name), older, older);
  return { left, right };
}

// The window runs at a real device scale factor of 1 (--force-device-scale-factor)
// and one CDP session pins the viewport and takes every screenshot, so captures
// are exactly 1440x900. Emulating a different DPR than the display's (as
// Playwright's scaled screenshots do) leaves the WebGL terminal drawn at the
// wrong scale, because it sizes its canvas from real device pixels.
let cdp;
async function pinViewport(page) {
  cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
}

async function shot(name, target = path.join(siteAssets, name), { settle = true } = {}) {
  if (settle) {
    // Let transient toasts fade out so they never end up in a capture.
    await page.waitForFunction(() => !document.getElementById("toast")?.classList.contains("show"), null, { timeout: 8_000 });
    await page.waitForTimeout(350);
  }
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await fs.writeFile(target, Buffer.from(data, "base64"));
  return target;
}

async function closeDialog(page, id) {
  const dialog = page.locator(`#${id}`);
  await dialog.locator(`[data-close-dialog="${id}"]`).first().click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
}

async function openCommandCenter(page, query) {
  await page.keyboard.press("Control+P");
  await page.locator("#command-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator("#command-input").fill("");
  await page.keyboard.type(query, { delay: 40 });
  await page.waitForTimeout(500);
}

async function waitForPanePath(page, pane, expected) {
  await page.waitForFunction(
    ({ pane: name, expected: value }) => document.querySelector(`[data-path-input="${name}"]`)?.value === value,
    { pane, expected },
    { timeout: 15_000 }
  );
  await page.waitForSelector(`.pane[data-pane="${pane}"] [data-entry-path]`, { timeout: 30_000 });
}

await fs.mkdir(siteAssets, { recursive: true });
const fixture = await createFixture();
await fs.mkdir(path.join(localAppData, "ExploreBetter", "MCP"), { recursive: true });
await fs.writeFile(
  path.join(localAppData, "ExploreBetter", "MCP", "bridge-config.json"),
  `${JSON.stringify({
    version: 1,
    enabled: true,
    auditRetentionDays: 30,
    profiles: [{
      id: "release-readonly",
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

const env = {
  ...process.env,
  // App state, caches, MCP config, and Chromium profile stay in the temp dir.
  LOCALAPPDATA: localAppData,
  EXPLORE_BETTER_USER_DATA_DIR: userData,
  EXPLORE_BETTER_UPDATE_URL: "",
  EXPLORE_BETTER_DISABLE_GPU: "1",
  // Home, special folders, and the Workspace shortcut resolve to the fixture.
  USERPROFILE: home,
  HOME: home,
  HOMEDRIVE: path.parse(home).root.replace(/\\$/, ""),
  HOMEPATH: home.slice(path.parse(home).root.length - 1),
  APPDATA: path.join(home, "AppData", "Roaming"),
  PSModuleAnalysisCachePath: path.join(localAppData, "PowerShell", "ModuleAnalysisCache"),
  EXPLORE_BETTER_WORKSPACE_ROOT: fixture.left,
  EXPLORE_BETTER_WORKSPACE_LABEL: "Project files"
};
for (const name of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) delete env[name];

const port = await freePort();
// Dev mode (electron.exe + app dir): process.defaultApp is true, so the
// startup shell-integration registry repair never runs. The packaged app is
// never launched.
const app = spawn(electronApp, [root, fixture.left, "--no-updates", "--force-device-scale-factor=1", `--remote-debugging-port=${port}`], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let logs = "";
app.stdout.on("data", (chunk) => { logs += chunk; });
app.stderr.on("data", (chunk) => { logs += chunk; });

let browser;
let page;
const captured = {};
try {
  await waitForCdp(port, app);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await waitForRenderer(browser);
  await pinViewport(page);
  await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 30_000 });
  await page.waitForTimeout(1_000);
  await dismissDefaultExplorerPrompt(page);

  // Hide the Preview panel so both panes get room for full columns and paths.
  await page.locator('#inspector [data-panel-action="preview"]').click();
  await page.locator('[data-path-input="right"]').fill(fixture.right);
  await page.locator('[data-path-input="right"]').press("Enter");
  await waitForPanePath(page, "right", fixture.right);
  await waitForPanePath(page, "left", fixture.left);
  const leftEntry = (name) => page.locator(`.pane[data-pane="left"] [data-entry-path$="${name}"]`).first();
  await leftEntry("team-photo.png").click();
  await page.waitForTimeout(1_500);
  await dismissDefaultExplorerPrompt(page);
  captured.workspace = await shot("workspace.png");

  await openCommandCenter(page, "disk");
  await page.waitForSelector("#command-dialog [data-palette-index]", { timeout: 10_000 });
  await page.waitForTimeout(400);
  captured.commandCenter = await shot("command-center.png");
  await page.keyboard.press("Escape");
  await page.locator("#command-dialog").waitFor({ state: "hidden", timeout: 10_000 });

  // Transfer preview: copy four files into Release ready, three of which
  // already exist there, with a different policy per conflict. The plan is
  // previewed only; Apply is never clicked.
  await leftEntry("README.md").click();
  for (const name of ["launch-plan.md", "meeting-notes.txt", "roadmap-2026.pdf"]) await leftEntry(name).click({ modifiers: ["Control"] });
  await openCommandCenter(page, "transfer selected");
  const transferCommand = page.locator("[data-palette-index]").filter({ hasText: "Transfer selected with policy" }).first();
  await transferCommand.waitFor({ state: "visible", timeout: 10_000 });
  await transferCommand.click();
  await page.locator("#transfer-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(() => {
    const summary = document.querySelector("#transfer-summary")?.textContent || "";
    return !/Previewing/i.test(summary) && document.querySelectorAll("#transfer-results .transfer-row").length >= 4;
  }, null, { timeout: 15_000 });
  for (const [name, policy] of [["meeting-notes.txt", "skip"], ["roadmap-2026.pdf", "overwrite"]]) {
    await page.locator(`#transfer-results [data-transfer-policy$="${name}"]`).selectOption(policy);
    await page.waitForFunction((expected) => {
      const summary = document.querySelector("#transfer-summary")?.textContent || "";
      return !/Previewing/i.test(summary) && summary.includes(`${expected}: 1`);
    }, policy, { timeout: 15_000 });
  }
  await page.waitForTimeout(500);
  captured.transferPreview = await shot("transfer-preview.png");
  await closeDialog(page, "transfer-dialog");

  // Disk Map on the whole project folder (not the current selection).
  await page.evaluate(() => document.querySelector('[data-topbar-action="sizeAnalysis"]')?.click());
  await page.locator("#size-analysis-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator("#size-analysis-path").fill(fixture.left);
  await page.locator('#size-analysis-dialog [data-size-analysis-action="scan"]').click();
  await page.waitForFunction((expected) => {
    const summary = document.querySelector("#size-analysis-summary")?.textContent || "";
    return !/Scanning/i.test(summary) && (document.querySelector("#size-analysis-map-breadcrumbs")?.textContent || "").includes(expected);
  }, path.basename(fixture.left), { timeout: 30_000 });
  await page.waitForFunction(() => {
    const summary = document.querySelector("#size-analysis-summary")?.textContent || "";
    const mapCount = Number.parseInt(document.querySelector("#size-analysis-map-count")?.textContent || "0", 10);
    const mapVisible = document.querySelector("#size-analysis-tab-map")?.getAttribute("aria-selected") === "true";
    return !/Scanning|Ready/i.test(summary) && mapVisible && mapCount > 0;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(900);
  captured.diskMap = await shot("disk-map.png");
  await closeDialog(page, "size-analysis-dialog");

  await page.evaluate(() => document.querySelector('[data-nav-action="open-devices"]')?.click());
  const devices = page.locator("#devices-dialog");
  await devices.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => {
    const refresh = document.querySelector("#devices-refresh");
    const groups = document.querySelector("#devices-groups")?.textContent || "";
    return refresh && !refresh.disabled && groups.trim().length > 0;
  }, null, { timeout: 20_000 });
  await page.waitForTimeout(300);
  captured.devices = await shot("devices.png");
  await closeDialog(page, "devices-dialog");

  await page.evaluate(() => document.querySelector('[data-global-action="preferences"]')?.click());
  const preferences = page.locator("#preferences-dialog");
  await preferences.waitFor({ state: "visible", timeout: 15_000 });
  await preferences.locator('[data-preferences-action="health"]').click();
  const health = page.locator("#health-dialog");
  await health.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => {
    const probe = document.querySelector("#health-probe");
    const components = document.querySelectorAll("#health-components .health-component");
    return probe && !probe.disabled && components.length >= 8;
  }, null, { timeout: 20_000 });
  await page.waitForTimeout(300);
  captured.health = await shot("health.png");
  await closeDialog(page, "health-dialog");
  if (await preferences.isVisible().catch(() => false)) await closeDialog(page, "preferences-dialog");

  // The terminal draws with WebGL, so its output is not in the DOM; the drawer
  // title's Busy -> Ready transition (driven by shell prompt markers) is the
  // completion signal instead.
  const terminalTitle = page.locator('[data-terminal-title="left"]');
  const waitForTerminalState = (state, timeout) => page.waitForFunction(
    (expected) => (document.querySelector('[data-terminal-title="left"]')?.textContent || "").endsWith(`/ ${expected}`),
    state,
    { timeout }
  );
  await page.locator('[data-terminal-toggle="left"]').click();
  const terminal = page.locator('[data-terminal-drawer="left"]');
  await terminal.waitFor({ state: "visible", timeout: 15_000 });
  const textarea = terminal.locator(".xterm-helper-textarea");
  await textarea.waitFor({ state: "attached", timeout: 15_000 });
  await waitForTerminalState("Ready", 20_000);
  // Give the drawer more height so the command and its output fit.
  const resizer = await page.locator('[data-layout-resize="terminal-left"]').boundingBox();
  await page.mouse.move(resizer.x + resizer.width / 2, resizer.y + resizer.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizer.x + resizer.width / 2, resizer.y - 160, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  await page.locator('[data-terminal-action="clear"][data-pane="left"]').click();
  await page.mouse.move(viewport.width - 40, viewport.height / 2);
  await page.waitForTimeout(400);
  await textarea.focus();
  await page.keyboard.type("Get-ChildItem -Recurse -File | Sort-Object Length -Descending | Select-Object -First 6 Name, @{n='MB';e={[int]($_.Length/1MB)}}");
  await page.keyboard.press("Enter");
  await waitForTerminalState("Busy", 5_000).catch(() => {});
  await waitForTerminalState("Ready", 20_000);
  await dismissDefaultExplorerPrompt(page);
  await page.waitForTimeout(1_000);
  if (!/\/ Ready$/.test(await terminalTitle.textContent())) throw new Error("The terminal did not return to Ready.");
  captured.terminal = await shot("terminal.png");
  await page.locator('[data-terminal-action="close"][data-pane="left"]').click().catch(() => {});

  await page.evaluate(() => document.querySelector('[data-global-action="preferences"]')?.click());
  await preferences.waitFor({ state: "visible", timeout: 15_000 });
  await page.evaluate(() => document.querySelector(".ai-bridge-preferences")?.scrollIntoView({ block: "start" }));
  await page.locator(".ai-bridge-preferences").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => {
    const section = document.querySelector(".ai-bridge-preferences");
    const profileCount = document.querySelector("#preference-ai-profile")?.options.length || 0;
    const toolCount = document.querySelectorAll("#preference-ai-tools input").length;
    return Boolean(window.exploreBetterDesktop?.aiBridge)
      && !section?.classList.contains("unavailable")
      && profileCount > 0
      && toolCount > 0;
  }, null, { timeout: 20_000 });
  await page.waitForTimeout(400);
  captured.aiBridge = await shot("ai-bridge.png");

  console.log(JSON.stringify(captured, null, 2));
} catch (error) {
  const failureShot = path.join(os.tmpdir(), "explore-better-capture-failure.png");
  if (cdp && await shot("", failureShot, { settle: false }).then(() => true, () => false)) console.error(`Failure screenshot: ${failureShot}`);
  throw new Error(`${error.message}\n${logs.slice(-5000)}`);
} finally {
  await browser?.close().catch(() => {});
  if (app.exitCode === null) spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  if (process.env.EXPLORE_BETTER_CAPTURE_KEEP_TEMP) console.error(`Kept ${temp} and ${home}`);
  else for (const dir of [temp, home]) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
