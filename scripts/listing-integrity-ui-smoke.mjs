// Regression coverage for renderer listing integrity:
// - a listing that raced a cache clear is not written back into the cache
// - path-bar autocomplete lists a parent folder once per pause, then filters locally
// - Modified sort orders ISO-string timestamps (restored snapshots)
// - re-opening the current folder with different letter case adds no back history
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { chromium } from "playwright-core";

const root = process.cwd();
const run = path.join(root, "artifacts", `listing-integrity-${Date.now()}`);
const home = path.join(run, "Home");
const other = path.join(run, "Other");
const raced = path.join(run, "Raced");
const dated = path.join(run, "Dated");
const appData = path.join(run, "appdata");
await Promise.all([home, other, raced, dated, appData].map((folder) => fs.mkdir(folder, { recursive: true })));
for (const name of ["alpha-one", "alpha-two", "beta"]) await fs.mkdir(path.join(home, name));
await fs.writeFile(path.join(home, "home.txt"), "home\n");
await fs.writeFile(path.join(raced, "raced.txt"), "raced\n");
await fs.writeFile(path.join(other, "other.txt"), "other\n");
// Name order (a, b, c) differs from modified order (b, c, a).
const datedFiles = [["a-file.txt", 3], ["b-file.txt", 1], ["c-file.txt", 2]];
for (const [name, day] of datedFiles) {
  const file = path.join(dated, name);
  await fs.writeFile(file, name);
  const when = new Date(Date.UTC(2024, 0, day, 12));
  await fs.utimes(file, when, when);
}

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), APPDATA: appData, LOCALAPPDATA: appData }
});
let output = "";
let browser;
server.stdout.on("data", (data) => { output += data; });
server.stderr.on("data", (data) => { output += data; });
const checks = [];
// Scenarios are independent, so record every result and fail at the end.
const check = (id, ok, detail = "") => {
  checks.push({ id, ok: Boolean(ok), detail: String(detail).slice(0, 600) });
};
const listPath = (requestUrl) => new URL(requestUrl).searchParams.get("path") || "";
const sameFolder = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

async function navigate(page, pane, target) {
  const input = page.locator(`[data-path-input="${pane}"]`);
  await input.fill(target);
  await input.press("Enter");
}

async function waitForPane(page, pane, target) {
  await page.waitForFunction(
    ({ pane, target }) => {
      const row = document.querySelector(`[data-list="${pane}"] [data-entry-path]`);
      const parent = String(row?.dataset.entryPath || "").replace(/[\\/][^\\/]+$/, "").toLowerCase();
      const activity = document.querySelector(`[data-pane-activity="${pane}"]`)?.className || "";
      return parent === target.toLowerCase() && /\b(ready|idle)\b/.test(activity) &&
        !document.querySelector(`[data-list="${pane}"] .bootstrap-file-row`);
    },
    { pane, target },
    { timeout: 10000 }
  );
}

async function waitForIdle(page, pane, requested) {
  for (let index = 0; index < 100 && !requested(); index += 1) await page.waitForTimeout(50);
  assert.ok(requested(), "The expected listing request was not made.");
  await page.waitForFunction(
    (pane) => /\b(ready|idle)\b/.test(document.querySelector(`[data-pane-activity="${pane}"]`)?.className || ""),
    pane
  );
}

try {
  for (let index = 0; index < 150; index += 1) {
    try { if ((await fetch(url)).ok) break; } catch {}
    if (server.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({
    executablePath: process.env.EB_INTERACTION_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(10000);
  await page.addInitScript(() => {
    window.exploreBetterDesktop = {
      aiBridge: { publishContext() {}, onAction(handler) { window.__testUiAction = handler; } }
    };
  });
  await page.route("**/api/windows/devices?**", (route) => route.fulfill({ json: { status: "ready", groups: {}, counts: {} } }));
  let createdFolders = 0;
  page.on("dialog", (dialog) => dialog.accept(`Created Folder ${++createdFolders}`));

  // One route for every listing so each scenario can observe or hold requests.
  const listRequests = [];
  let holdRaced = null;
  let isoDates = false;
  await page.route("**/api/list?**", async (route) => {
    const requestUrl = route.request().url();
    listRequests.push(requestUrl);
    const target = listPath(requestUrl);
    if (holdRaced && sameFolder(target, raced)) {
      const hold = holdRaced;
      holdRaced = null;
      hold.arrive();
      await hold.allowed;
    }
    if (isoDates && sameFolder(target, dated)) {
      const response = await route.fetch();
      const data = await response.json();
      for (const entry of data.entries || []) {
        for (const key of ["modified", "created", "accessed"]) {
          if (Number.isFinite(entry[key])) entry[key] = new Date(entry[key]).toISOString();
        }
      }
      await route.fulfill({ response, json: data });
      return;
    }
    await route.continue();
  });

  await page.goto(`${url}/?left=${encodeURIComponent(home)}&right=${encodeURIComponent(other)}`, { waitUntil: "domcontentloaded" });
  await waitForPane(page, "left", home);
  await waitForPane(page, "right", other);

  // 5. Autocomplete: one parent listing per typing pause, local filtering after.
  const input = page.locator('[data-path-input="left"]');
  await input.click();
  await input.fill("");
  const suggestionRequests = () => listRequests.filter((item) => !new URL(item).searchParams.has("includeDimensions"));
  const beforeTyping = suggestionRequests().length;
  const typed = `${home}\\al`;
  await page.keyboard.type(typed, { delay: 8 });
  await page.waitForFunction(() => {
    const labels = [...document.querySelectorAll("[data-path-suggest] .path-suggest-item strong")].map((node) => node.textContent);
    return labels.includes("alpha-one") && labels.includes("alpha-two");
  });
  // At most one listing per parent folder typed (not one per keystroke), and
  // never the same parent twice.
  const burstParents = suggestionRequests().slice(beforeTyping).map(listPath);
  const parentCount = typed.split(/[\\/]/).length;
  check(
    "autocomplete-burst-is-debounced",
    burstParents.length <= parentCount && new Set(burstParents.map((item) => item.toLowerCase())).size === burstParents.length,
    `${burstParents.length} listing request(s) for ${typed.length} keystrokes across ${parentCount} folders: ${burstParents.join(" | ")}`
  );
  const afterBurst = suggestionRequests().length;
  await page.keyboard.type("pha-t", { delay: 40 });
  await page.waitForFunction(() => {
    const labels = [...document.querySelectorAll("[data-path-suggest] .path-suggest-item strong")].map((node) => node.textContent);
    return labels.includes("alpha-two") && !labels.includes("alpha-one");
  });
  await page.waitForTimeout(250);
  const filterRequests = suggestionRequests().length - afterBurst;
  check("autocomplete-filters-cached-parent", filterRequests === 0, `${filterRequests} extra listing request(s) while narrowing within the same folder.`);
  await page.keyboard.press("Escape");
  await navigate(page, "left", home);
  await waitForPane(page, "left", home);

  // 1. A listing that was in flight when the cache was cleared is not cached.
  let release;
  let arrive;
  const allowed = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { arrive = resolve; });
  holdRaced = { allowed, arrive };
  await navigate(page, "left", raced);
  await arrived;
  // Creating a folder in the other pane is a mutating request that clears the listing cache.
  await page.locator('[data-action="new-folder"][data-pane="right"]').dispatchEvent("click");
  await page.waitForFunction(() => /Folder created/.test(document.getElementById("toast")?.textContent || ""));
  release();
  await waitForPane(page, "left", raced);
  await navigate(page, "left", home);
  await waitForPane(page, "left", home);
  await navigate(page, "left", raced);
  await waitForPane(page, "left", raced);
  const racedStatus = await page.locator("#status-pill").textContent();
  check("raced-listing-not-cached", !/\/ cached/.test(racedStatus || ""), `Revisit status: ${racedStatus}`);

  // 11. Same folder with different letter case: no back history entry. Clear
  // the cache first so the listing (and its path spelling) comes from the server.
  await page.locator('[data-action="new-folder"][data-pane="right"]').dispatchEvent("click");
  await page.waitForFunction((count) => document.querySelectorAll('[data-list="right"] [data-entry-path]').length >= count, 3);
  const backTarget = async () => (await page.evaluate(() =>
    window.__testUiAction({ type: "describe", request: { type: "semantic", actionId: "pane.navigate.back", pane: "left" } })
  )).paths?.[0] || "";
  const backBefore = await backTarget();
  const racedUpper = raced.toUpperCase();
  const requestsBeforeUpper = listRequests.length;
  await navigate(page, "left", racedUpper);
  await waitForIdle(page, "left", () => listRequests.slice(requestsBeforeUpper).some((item) => listPath(item) === racedUpper));
  const backAfter = await backTarget();
  check("case-only-path-change-adds-no-history", backAfter === backBefore, `Back target changed from ${backBefore} to ${backAfter}.`);

  // 7. Modified sort with ISO-string timestamps.
  isoDates = true;
  await navigate(page, "left", dated);
  await waitForPane(page, "left", dated);
  const sortedNames = async () => page.evaluate(() =>
    [...document.querySelectorAll('[data-list="left"] [data-entry-path]')].map((row) => row.dataset.entryPath.split(/[\\/]/).pop())
  );
  await page.locator('.pane[data-pane="left"] .file-head [data-sort="modified"]').click();
  await page.waitForFunction(() => document.querySelector('.pane[data-pane="left"] .file-head [data-sort="modified"]')?.classList.contains("active"));
  const direction = await page.locator('.pane[data-pane="left"] .file-head [data-sort="modified"]').getAttribute("aria-label");
  const ascending = ["b-file.txt", "c-file.txt", "a-file.txt"];
  const expected = /descending/.test(direction || "") ? [...ascending].reverse() : ascending;
  const names = await sortedNames();
  check("iso-modified-sort", JSON.stringify(names) === JSON.stringify(expected), `${direction}: ${names.join(", ")}`);
  await page.locator('.pane[data-pane="left"] .file-head [data-sort="modified"]').click();
  await page.waitForFunction((first) => {
    const row = document.querySelector('[data-list="left"] [data-entry-path]');
    return row && !row.dataset.entryPath.endsWith(first);
  }, names[0]);
  const reversed = await sortedNames();
  check("iso-modified-sort-reverses", JSON.stringify(reversed) === JSON.stringify([...expected].reverse()), reversed.join(", "));

  // 16. A plain "/" launch (what Electron loads) prefetches the saved active
  // folder from bootstrap.js, with the exact route the app then consumes.
  let savedLeft = "";
  for (let index = 0; index < 60 && !sameFolder(savedLeft || run, dated); index += 1) {
    await page.waitForTimeout(100);
    const state = await (await fetch(`${url}/api/state`)).json();
    const leftPane = state.layout?.panes?.left;
    savedLeft = leftPane?.tabs?.[Number(leftPane.activeTab || 0)]?.path || "";
  }
  await page.close();
  const launch = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  launch.setDefaultTimeout(10000);
  await launch.route("**/api/windows/devices?**", (route) => route.fulfill({ json: { status: "ready", groups: {}, counts: {} } }));
  const launchListings = [];
  let listingSeen;
  const listingBeforeApp = new Promise((resolve) => { listingSeen = resolve; });
  await launch.route("**/api/list?**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (sameFolder(requestUrl.searchParams.get("path") || run, dated)) {
      launchListings.push(requestUrl.search);
      listingSeen(true);
    }
    await route.continue();
  });
  // Hold the application bundle so only bootstrap.js can have requested the listing.
  let prefetchedBeforeApp = false;
  await launch.route("**/generated/app-runtime.js", async (route) => {
    prefetchedBeforeApp = await Promise.race([listingBeforeApp, new Promise((resolve) => setTimeout(() => resolve(false), 3000))]);
    await route.continue();
  });
  await launch.goto(`${url}/`, { waitUntil: "domcontentloaded" });
  await waitForPane(launch, "left", dated);
  const windowedRequests = launchListings.filter((search) => new URLSearchParams(search).get("limit") === "48");
  check("bootstrap-prefetches-saved-folder", prefetchedBeforeApp === true, `Saved left folder ${savedLeft}.`);
  check("bootstrap-prefetch-is-consumed", windowedRequests.length === 1, `${windowedRequests.length} first-window request(s): ${windowedRequests.join(" | ")}`);

  const failed = checks.filter((item) => !item.ok);
  assert.equal(failed.length, 0, failed.map((item) => `${item.id}: ${item.detail}`).join("\n"));
  console.log(JSON.stringify({ status: "pass", checks }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "fail", checks, error: error.message, output: output.slice(-2000) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  await fs.rm(run, { recursive: true, force: true }).catch(() => {});
}
