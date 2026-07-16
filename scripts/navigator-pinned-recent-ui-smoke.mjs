import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(root, "artifacts", `navigator-product-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const outputPath = path.join(root, "artifacts", "navigator-product-ui-latest.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Navigator test server exited with ${child.exitCode}.`);
    try {
      if ((await fetch(`${baseUrl}/api/roots`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Navigator test server did not become ready.");
}

async function saveState(baseUrl, state) {
  const response = await fetch(`${baseUrl}/api/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state)
  });
  assert(response.ok, `Could not save Navigator fixture state: ${response.status}.`);
}

async function snapshot(page) {
  return page.evaluate(() => {
    const visible = (element) => element && !element.hidden && getComputedStyle(element).display !== "none";
    const rail = document.querySelector(".nav-rail");
    const children = [...document.querySelectorAll("#nav-pinned, #folder-tree, #nav-devices, #nav-shortcuts, #nav-drives, #nav-recents")];
    return {
      pinnedHidden: !visible(document.getElementById("nav-pinned-section")),
      pinned: [...document.querySelectorAll("#nav-pinned .nav-row")].map((row) => ({
        name: row.querySelector(".nav-text > span")?.textContent?.trim() || "",
        detail: row.querySelector(".nav-text small")?.textContent?.trim() || "",
        glyph: row.querySelector(".nav-code")?.textContent?.trim() || "",
        removable: Boolean(row.querySelector("[data-remove-favorite]"))
      })),
      recentHidden: !visible(document.querySelector(".recent-section")),
      recentCount: document.querySelectorAll("#nav-recents .nav-row").length,
      recentToggleHidden: !visible(document.getElementById("nav-recents-toggle")),
      recentToggleText: document.getElementById("nav-recents-toggle")?.textContent?.trim() || "",
      deviceHidden: !visible(document.getElementById("nav-devices-section")),
      deviceActions: [...document.querySelectorAll("#devices-groups [data-device-action]")].map((item) => item.textContent.trim()),
      sectionOrder: [...document.querySelectorAll(".nav-rail > .nav-section")].filter(visible).map((item) => {
        const title = document.getElementById(item.getAttribute("aria-labelledby") || "") || item.querySelector(".nav-section-title");
        return title?.querySelector(":scope > span:first-child")?.textContent?.trim() || title?.textContent?.trim() || item.id;
      }),
      railScrollOwner: rail ? ["auto", "scroll"].includes(getComputedStyle(rail).overflowY) : false,
      nestedScrollOwners: children.filter((element) => {
        const style = getComputedStyle(element);
        return ["auto", "scroll"].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
      }).map((element) => element.id)
    };
  });
}

await fs.mkdir(fixture, { recursive: true });
await fs.mkdir(appData, { recursive: true });
const locations = [];
for (let index = 0; index < 20; index += 1) {
  const location = path.join(fixture, `location-${String(index + 1).padStart(2, "0")}`);
  await fs.mkdir(location, { recursive: true });
  await fs.writeFile(path.join(location, "visible.txt"), `location ${index + 1}\n`, "utf8");
  locations.push({ id: `recent-${index}`, name: `Location ${index + 1}`, path: location, visitedAt: new Date(Date.now() - index * 60_000).toISOString() });
}

const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let browser;
const evidence = {};
let deviceMode = "empty";
const deviceRequests = [];
try {
  await waitForServer(baseUrl, server);
  browser = await chromium.launch({ executablePath: process.env.EB_NAVIGATOR_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route("**/api/windows/devices?*", async (route) => {
    const requestUrl = new URL(route.request().url());
    deviceRequests.push({ includeNetwork: requestUrl.searchParams.get("includeNetwork"), refresh: requestUrl.searchParams.get("refresh") });
    const meaningful = deviceMode === "meaningful";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ready",
        warnings: [],
        networkLoaded: requestUrl.searchParams.get("includeNetwork") === "1",
        counts: { connectedDevices: meaningful ? 1 : 0, removableDrives: 0, mappedNetworkLocations: 0, fixedDrives: 1, windowsLocations: 0 },
        groups: {
          connectedDevices: meaningful ? [{ id: "portable-1", name: "Test phone", kind: "portable", detail: "Connected", connectionState: "connected", capacity: null, path: "", openTarget: "shell:test-phone", capabilities: { browseInApp: false, browseShell: true, openInExplorer: true } }] : [],
          drives: [{ id: "fixed-1", name: "System drive", kind: "fixed", detail: "Fixed", connectionState: "connected", capacity: null, path: fixture, openTarget: fixture, capabilities: { browseInApp: true, browseShell: false, openInExplorer: true } }],
          network: [], libraries: [], windowsLocations: []
        }
      })
    });
  });

  const load = async (state) => {
    await saveState(baseUrl, state);
    const browsePath = state.recentLocations?.[0]?.path || fixture;
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(browsePath)}&right=${encodeURIComponent(browsePath)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]');
    await page.waitForTimeout(80);
    return snapshot(page);
  };

  await load({ favorites: [], aliases: [], recentLocations: [] });
  await page.locator('[data-nav-action="clear-recents"]').click();
  await page.waitForFunction(() => document.querySelector(".recent-section")?.hidden === true);
  evidence.empty = await snapshot(page);
  assert(evidence.empty.pinnedHidden && evidence.empty.recentHidden, `Empty Pinned/Recent sections remained visible: ${JSON.stringify(evidence.empty)}.`);

  evidence.favorite = await load({ favorites: [{ id: "favorite-1", name: "Favorite location", path: locations[0].path, color: "gold" }], aliases: [], recentLocations: locations.slice(0, 1) });
  assert(evidence.favorite.pinned.length === 1 && /^Favorite \/ /.test(evidence.favorite.pinned[0].detail) && evidence.favorite.pinned[0].removable, `Favorite-only Pinned rendering is incorrect: ${JSON.stringify(evidence.favorite.pinned)}.`);

  evidence.alias = await load({ favorites: [], aliases: [{ id: "alias-1", name: "proj", path: locations[1].path }], recentLocations: locations.slice(0, 8) });
  assert(evidence.alias.pinned.length === 1 && /^Alias \/ /.test(evidence.alias.pinned[0].detail) && !evidence.alias.pinned[0].removable, `Alias-only Pinned rendering is incorrect: ${JSON.stringify(evidence.alias.pinned)}.`);

  evidence.mixed = await load({ favorites: [{ id: "favorite-1", name: "Favorite location", path: locations[0].path, color: "gold" }], aliases: [{ id: "alias-1", name: "proj", path: locations[1].path }], recentLocations: locations.slice(0, 9) });
  assert(evidence.mixed.pinned.length === 2 && new Set(evidence.mixed.pinned.map((item) => item.glyph)).size === 2, `Mixed Pinned types do not have distinct icons: ${JSON.stringify(evidence.mixed.pinned)}.`);
  assert(evidence.mixed.recentCount === 8 && evidence.mixed.recentToggleText === "Show all (9)", `Nine-item Recent disclosure is incorrect: ${JSON.stringify(evidence.mixed)}.`);
  await page.locator("#nav-recents-toggle").click();
  evidence.recentNineExpanded = await snapshot(page);
  assert(evidence.recentNineExpanded.recentCount === 9 && evidence.recentNineExpanded.recentToggleText === "Show fewer", "Show all/fewer did not expand nine Recent entries.");

  evidence.recentTwenty = await load({ favorites: [], aliases: [], recentLocations: locations });
  assert(evidence.recentTwenty.recentCount === 8 && evidence.recentTwenty.recentToggleText === "Show all (20)", `Twenty-item Recent disclosure is incorrect: ${JSON.stringify(evidence.recentTwenty)}.`);

  deviceMode = "meaningful";
  evidence.device = await load({ favorites: [], aliases: [], recentLocations: locations.slice(0, 1) });
  await page.waitForFunction(() => document.getElementById("nav-devices-section")?.hidden === false);
  evidence.device = await snapshot(page);
  assert(!evidence.device.deviceHidden, "A meaningful portable device did not reveal the dynamic Navigator section.");
  assert(evidence.device.sectionOrder.indexOf("Folder Tree") < evidence.device.sectionOrder.indexOf("Devices") && evidence.device.sectionOrder.indexOf("Folder Tree") < evidence.device.sectionOrder.indexOf("Drives"), `Navigator section order is incorrect: ${evidence.device.sectionOrder.join(" > ")}.`);
  assert(evidence.device.railScrollOwner && evidence.device.nestedScrollOwners.length === 0, `Navigator gained nested scroll owners: ${JSON.stringify(evidence.device)}.`);
  assert(deviceRequests.every((item) => item.includeNetwork !== "1"), `Initial Navigator loading probed the Network provider: ${JSON.stringify(deviceRequests)}.`);
  await page.locator('[data-nav-action="open-devices"]').click();
  await page.waitForSelector("#devices-dialog[open] .device-card");
  evidence.deviceDashboard = await snapshot(page);
  assert(
    ["Browse in Explore Better", "Open in active pane", "Open in File Explorer"].every((label) => evidence.deviceDashboard.deviceActions.includes(label))
      && !evidence.deviceDashboard.deviceActions.some((label) => ["Open", "Browse", "Launch"].includes(label)),
    `Device dashboard action labels are ambiguous or capability-incomplete: ${JSON.stringify(evidence.deviceDashboard.deviceActions)}.`
  );
  await page.locator('#devices-dialog [data-close-dialog="devices-dialog"]').click();

  deviceMode = "empty";
  evidence.deviceRemoved = await load({ favorites: [], aliases: [], recentLocations: locations.slice(0, 1) });
  assert(evidence.deviceRemoved.deviceHidden, "The dynamic Devices section remained visible after meaningful devices disappeared.");

  await fs.writeFile(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), status: "pass", evidence, deviceRequests }, null, 2)}\n`);
  console.log("Navigator product UI smoke passed: empty/favorite/alias/mixed Pinned, 0/1/8/9/20 Recent behavior, dynamic Devices, section order, and single-scroll ownership.");
} finally {
  await browser?.close().catch(() => {});
  if (server.exitCode === null) server.kill();
  await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
}
