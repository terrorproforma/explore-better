import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { chromium } from "playwright-core";

const root = process.cwd();
const packagedApp = path.join(root, "dist", "win-unpacked", "Explore Better.exe");
const siteAssets = path.join(root, "site", "assets");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "explore-better-site-capture-"));
const localAppData = path.join(temp, "LocalAppData");
const userData = path.join(temp, "Electron");

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

async function dismissDefaultExplorerPrompt(page) {
  const dialog = page.locator("#default-explorer-dialog");
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.locator('[data-default-explorer-choice="keep"]').click();
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    return true;
  }
  return false;
}

await fs.access(packagedApp);
await fs.mkdir(path.join(localAppData, "ExploreBetter", "MCP"), { recursive: true });
await fs.mkdir(siteAssets, { recursive: true });
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
      roots: [root],
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
const app = spawn(packagedApp, [root, "--no-updates", `--remote-debugging-port=${port}`], {
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
try {
  await waitForCdp(port, app);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await waitForRenderer(browser);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 30_000 });

  await page.waitForTimeout(1_500);
  await dismissDefaultExplorerPrompt(page);

  await page.screenshot({ path: path.join(siteAssets, "workspace.png"), captureBeyondViewport: false });

  await page.evaluate(() => document.querySelector('[data-nav-action="open-devices"]')?.click());
  const devices = page.locator("#devices-dialog");
  await devices.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => {
    const refresh = document.querySelector("#devices-refresh");
    const groups = document.querySelector("#devices-groups")?.textContent || "";
    return refresh && !refresh.disabled && groups.trim().length > 0;
  }, null, { timeout: 20_000 });
  await page.screenshot({ path: path.join(siteAssets, "devices.png"), captureBeyondViewport: false });
  await devices.locator('[data-close-dialog="devices-dialog"]').click();

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
  await page.screenshot({ path: path.join(siteAssets, "health.png"), captureBeyondViewport: false });
  await health.locator('[data-close-dialog="health-dialog"]').click();

  await page.locator('[data-terminal-toggle="left"]').click();
  const terminal = page.locator('[data-terminal-drawer="left"]');
  await terminal.waitFor({ state: "visible", timeout: 15_000 });
  const textarea = terminal.locator(".xterm-helper-textarea");
  await textarea.waitFor({ state: "attached", timeout: 15_000 });
  await textarea.focus();
  await page.keyboard.type("Write-Host 'Explore Better terminal ready'; Get-Location");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const output = document.querySelector('[data-terminal-drawer="left"] .xterm-rows')?.textContent || "";
    return output.includes("Explore Better terminal ready") && output.includes("Path");
  }, null, { timeout: 15_000 });
  await dismissDefaultExplorerPrompt(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(siteAssets, "terminal.png"), captureBeyondViewport: false });

  await page.evaluate(() => document.querySelector('[data-global-action="preferences"]')?.click());
  await page.locator("#preferences-dialog").waitFor({ state: "visible", timeout: 15_000 });
  await page.evaluate(() => document.querySelector(".ai-bridge-preferences")?.scrollIntoView({ block: "start" }));
  const aiBridge = page.locator(".ai-bridge-preferences");
  await aiBridge.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => {
    const section = document.querySelector(".ai-bridge-preferences");
    const profileCount = document.querySelector("#preference-ai-profile")?.options.length || 0;
    const toolCount = document.querySelectorAll("#preference-ai-tools input").length;
    return Boolean(window.exploreBetterDesktop?.aiBridge)
      && !section?.classList.contains("unavailable")
      && profileCount > 0
      && toolCount > 0;
  }, null, { timeout: 20_000 });
  const aiBridgeState = await page.evaluate(() => ({
    bridgeAvailable: Boolean(window.exploreBetterDesktop?.aiBridge),
    unavailable: document.querySelector(".ai-bridge-preferences")?.classList.contains("unavailable"),
    profileOptions: document.querySelector("#preference-ai-profile")?.options.length || 0,
    toolOptions: document.querySelectorAll("#preference-ai-tools input").length,
    clientStatus: document.querySelector("#preference-ai-client-status")?.textContent?.trim() || "",
    snippet: document.querySelector("#preference-ai-snippet")?.textContent?.trim() || ""
  }));
  if (!aiBridgeState.bridgeAvailable || aiBridgeState.unavailable || aiBridgeState.profileOptions < 1 || aiBridgeState.toolOptions < 1) {
    throw new Error(`AI Bridge capture state is incomplete: ${JSON.stringify(aiBridgeState)}`);
  }
  await page.screenshot({ path: path.join(siteAssets, "ai-bridge.png"), captureBeyondViewport: false });

  console.log(JSON.stringify({
    workspace: path.join(siteAssets, "workspace.png"),
    devices: path.join(siteAssets, "devices.png"),
    health: path.join(siteAssets, "health.png"),
    terminal: path.join(siteAssets, "terminal.png"),
    aiBridge: path.join(siteAssets, "ai-bridge.png")
  }));
} catch (error) {
  throw new Error(`${error.message}\n${logs.slice(-5000)}`);
} finally {
  await browser?.close().catch(() => {});
  if (app.exitCode === null) spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
