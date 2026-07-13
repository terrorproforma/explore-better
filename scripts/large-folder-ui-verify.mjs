import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(os.tmpdir(), `explore-better-large-folder-ui-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
let serverOutput = "";

const viewports = [
  { name: "desktop", width: 1440, height: 920 },
  { name: "small-desktop", width: 1024, height: 760 }
];

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_LARGE_UI_KEEP_FIXTURE === "1";
}

function countOption() {
  const value = Number(optionValue("--count", process.env.EB_LARGE_UI_COUNT || "10000"));
  return Number.isInteger(value) && value > 0 ? value : 10000;
}

function repetitionCount(count) {
  const fallback = count >= 100000 ? 3 : 1;
  const value = Number(optionValue("--repetitions", process.env.EB_LARGE_UI_REPETITIONS || String(fallback)));
  return Number.isInteger(value) ? Math.min(5, Math.max(1, value)) : fallback;
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function selectedViewports() {
  const selected = String(optionValue("--viewports", process.env.EB_LARGE_UI_VIEWPORTS || ""))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!selected.length) {
    return viewports;
  }
  const selectedNames = new Set(selected);
  const matches = viewports.filter((viewport) => selectedNames.has(viewport.name));
  return matches.length ? matches : viewports;
}

function outputName() {
  const name = optionValue("--output", process.env.EB_LARGE_UI_OUTPUT || "large-folder-ui-latest.json");
  return path.basename(name);
}

function screenshotPrefix() {
  return optionValue("--screenshot-prefix", process.env.EB_LARGE_UI_SCREENSHOT_PREFIX || "large-folder-ui")
    .replace(/[^a-z0-9_.-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "large-folder-ui";
}

function edgePath() {
  return (
    optionValue("--browser", process.env.EB_LARGE_UI_BROWSER || "") ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
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
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function waitForServer(baseUrl, child) {
  const started = performance.now();
  while (performance.now() - started < 10000) {
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

async function writeBatch(files) {
  await Promise.all(files.map(([file, text]) => fs.writeFile(file, text)));
}

async function prepareFixture(count) {
  const dir = path.join(fixtureRoot, `huge-${count}`);
  const marker = path.join(dir, ".large-folder-ui-ready.json");
  await fs.mkdir(dir, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(marker, "utf8"));
    if (parsed.count === count) {
      return dir;
    }
  } catch {
    // Build below.
  }
  const batch = [];
  for (let index = 0; index < count; index += 1) {
    const padded = String(index).padStart(6, "0");
    const name =
      index === count - 1
        ? `needle-ui-target-${padded}.md`
        : index % 25 === 0
        ? `folderish-name-${padded}.json`
        : index % 9 === 0
        ? `image-ish-${padded}.png`
        : `target-${padded}.txt`;
    batch.push([path.join(dir, name), `large ui fixture ${index}\n${name}\n`]);
    if (batch.length >= 500) {
      await writeBatch(batch.splice(0));
    }
  }
  if (batch.length) {
    await writeBatch(batch);
  }
  await fs.writeFile(marker, JSON.stringify({ count, generatedAt: new Date().toISOString() }, null, 2), "utf8");
  return dir;
}

async function timed(label, run) {
  const started = performance.now();
  const result = await run();
  return {
    label,
    wallMs: Math.round((performance.now() - started) * 10) / 10,
    result
  };
}

async function inspectHeader(page) {
  return page.evaluate(() => {
    const selectors = [
      [".pane.active .pathbar > button.icon-button", "pathbar"],
      [".pane.active .pathbar > input", "pathbar"],
      [".pane.active .breadcrumb-button", "breadcrumbs"],
      [".pane.active .breadcrumb-menu-button", "breadcrumbs"],
      [".pane.active .toolbar button", "toolbar"],
      [".pane.active .toolbar input", "toolbar"],
      [".pane.active .toolbar select", "toolbar"],
      [".pane.active .file-head button", "file-head"],
      [".command-dock > button:not([hidden])", "dock"],
      [".command-dock > select", "dock"],
      [".layout-toggle button", "layout-toggle"]
    ];
    const issues = [];
    const samples = [];
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const clippedText = (element, area) => {
      if (element.matches("input, select, textarea")) return false;
      if (area === "breadcrumbs") return false;
      if (element.classList.contains("pane-command")) return false;
      if (area === "file-head") {
        const title = element.querySelector(".column-title");
        return Boolean(title && title.textContent.trim().length > 2 && title.scrollWidth > title.clientWidth + 4);
      }
      const text = (element.innerText || element.textContent || element.value || "").trim();
      return text.length > 2 && element.scrollWidth > element.clientWidth + 4;
    };
    for (const [selector, area] of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const text = (element.innerText || element.textContent || element.value || "").trim().replace(/\s+/g, " ");
        const isIcon = text.length <= 2 || element.classList.contains("icon-button") || element.classList.contains("pane-command");
        const minWidth = area === "breadcrumbs" ? (isIcon ? 20 : 30) : isIcon ? 24 : 36;
        const minHeight = area === "breadcrumbs" ? 20 : 24;
        const clipped = clippedText(element, area);
        const squished = rect.width < minWidth || rect.height < minHeight;
        const verticallyLost = rect.bottom < 0 || rect.top > viewport.height;
        samples.push({
          area,
          text,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          clipped,
          squished
        });
        if (clipped || squished || (!["dock", "toolbar", "layout-toggle"].includes(area) && verticallyLost)) {
          issues.push({
            area,
            text,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            clipped,
            squished,
            verticallyLost
          });
        }
      }
    }
    return { viewport, issues, samples };
  });
}

async function inspectVirtualList(page, expectedCount) {
  return page.evaluate((count) => {
    const list = document.querySelector('[data-list="left"]');
    const entries = [...document.querySelectorAll('[data-list="left"] [data-entry-path]')];
    const spacer = document.querySelector('[data-list="left"] .virtual-spacer');
    const windowElement = document.querySelector('[data-list="left"] [data-virtual-window]');
    const first = entries[0]?.getAttribute("data-entry-path") || "";
    const last = entries.at(-1)?.getAttribute("data-entry-path") || "";
    return {
      expectedCount: count,
      virtualized: Boolean(list?.classList.contains("virtualized")),
      renderedRows: entries.length,
      listClientHeight: list?.clientHeight || 0,
      listScrollHeight: list?.scrollHeight || 0,
      spacerHeight: parseFloat(spacer?.style.height || "0") || 0,
      windowTransform: windowElement?.style.transform || "",
      first,
      last,
      pathValue: document.querySelector('[data-path-input="left"]')?.value || "",
      status: document.querySelector("#status-pill")?.textContent || ""
    };
  }, expectedCount);
}

async function setupWindowFirstProbe(page, fixture, options = {}) {
  const probe = {
    requests: [],
    fullResolvers: [],
    released: false,
    release() {
      this.released = true;
      for (const resolve of this.fullResolvers.splice(0)) {
        resolve();
      }
    }
  };
  await page.route("**/api/list**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const targetPath = requestUrl.searchParams.get("path") || "";
    const isFixture = targetPath === fixture;
    const isWindow = requestUrl.searchParams.has("offset") || requestUrl.searchParams.has("limit");
    if (isFixture) {
      probe.requests.push({
        isWindow,
        offset: requestUrl.searchParams.get("offset") || "",
        limit: requestUrl.searchParams.get("limit") || "",
        format: requestUrl.searchParams.get("format") || "",
        url: route.request().url()
      });
      if (!isWindow && probe.requests.some((request) => request.isWindow) && !probe.released) {
        await new Promise((resolve) => probe.fullResolvers.push(resolve));
      }
    }
    if (isFixture && options.bypassCache) {
      requestUrl.searchParams.set("bypassCache", "true");
      await route.continue({ url: requestUrl.toString() });
    } else {
      await route.continue();
    }
  });
  return probe;
}

async function runViewport(page, baseUrl, fixture, viewport, count, options = {}) {
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  const windowProbe = await setupWindowFirstProbe(page, fixture, { bypassCache: options.bypassCache });
  let windowFirst = null;
  let firstWindowPaint = null;
  let fullHydration = null;
  const navigate = await timed(`${viewport.name}-navigate`, async () => {
    firstWindowPaint = await timed(`${viewport.name}-first-window-paint`, async () => {
      await page.goto(
        `${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`,
        { waitUntil: "domcontentloaded", timeout: 30000 }
      );
      await page.waitForFunction(
        () => {
          const list = document.querySelector('[data-list="left"]');
          const rows = [...document.querySelectorAll('[data-list="left"] [data-entry-path]')];
          const status = document.querySelector("#status-pill")?.textContent || "";
          return (
            Boolean(list && !list.classList.contains("virtualized")) &&
            rows.length > 0 &&
            rows.length <= 220 &&
            /loading full list/i.test(status)
          );
        },
        { timeout: 30000 }
      );
      return inspectVirtualList(page, count);
    });
    windowFirst = firstWindowPaint.result;
    fullHydration = await timed(`${viewport.name}-full-list-hydration`, async () => {
      windowProbe.release();
      await page.waitForFunction(
        () => {
          const list = document.querySelector('[data-list="left"]');
          return Boolean(list?.classList.contains("virtualized") && list.querySelector("[data-entry-path]"));
        },
        { timeout: 30000 }
      );
    });
  });

  const firstFixtureRequest = windowProbe.requests[0];
  assert(firstFixtureRequest?.isWindow, `${viewport.name}: first browser /api/list request should be windowed.`);
  assert(
    windowProbe.requests.some((request) => !request.isWindow),
    `${viewport.name}: browser should request a full-list hydration after the window.`
  );
  assert(
      windowProbe.requests.filter((request) => !request.isWindow).every((request) => request.format === "compact-v2"),
      `${viewport.name}: full-list hydration should use compact-v2.`
  );
  assert(
    windowFirst?.renderedRows > 0 && windowFirst.renderedRows <= 220 && !windowFirst.virtualized,
    `${viewport.name}: first paint should show the bounded listing window, got ${JSON.stringify(windowFirst)}.`
  );
  if (count >= 100000 && options.enforcePerformance !== false) {
    assert(
      /[0-9,]+\+ items/i.test(windowFirst?.status || ""),
      `${viewport.name}: cold streaming window should expose an unknown-total progress state, got ${windowFirst?.status}.`
    );
    assert(
      Number(firstWindowPaint?.wallMs || Infinity) <= 750,
      `${viewport.name}: cold first visible window must paint within 750ms, got ${firstWindowPaint?.wallMs}ms.`
    );
    assert(
      Number(fullHydration?.wallMs || Infinity) <= 2000,
      `${viewport.name}: full hydration must finish within 2000ms after first paint, got ${fullHydration?.wallMs}ms.`
    );
  }

  const header = await inspectHeader(page);
  const virtualInitial = await inspectVirtualList(page, count);
  assert(virtualInitial.virtualized, `${viewport.name}: large folder should use virtualized rendering.`);
  assert(
    virtualInitial.renderedRows > 0 && virtualInitial.renderedRows < 500,
    `${viewport.name}: virtualized list should render a bounded row window, got ${virtualInitial.renderedRows}.`
  );
  assert(
    virtualInitial.spacerHeight >= count * 25,
    `${viewport.name}: virtual spacer should represent the full folder height.`
  );
  assert(header.issues.length === 0, `${viewport.name}: header/layout issues: ${JSON.stringify(header.issues)}`);

  let filter = null;
  let scroll = null;
  if (options.exerciseInteractions) {
    filter = await timed("client-filter", async () => {
      await page.locator('[data-filter="left"]').fill("needle-ui-target");
      await page.waitForFunction(
        () => {
          const rows = [...document.querySelectorAll('[data-list="left"] [data-entry-path]')];
          return rows.length === 1 && rows[0].textContent.includes("needle-ui-target");
        },
        { timeout: 5000 }
      );
      return inspectVirtualList(page, count);
    });
    assert(filter.wallMs < 2500, `Filtering ${count} UI entries should stay responsive, got ${filter.wallMs}ms.`);

    await page.locator('[data-filter="left"]').fill("");
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-list="left"]')?.classList.contains("virtualized")),
      { timeout: 10000 }
    );
    const beforeScroll = await inspectVirtualList(page, count);
    scroll = await timed("virtual-scroll-bottom", async () => {
      await page.evaluate(() => {
        const list = document.querySelector('[data-list="left"]');
        list.scrollTop = list.scrollHeight;
        list.dispatchEvent(new Event("scroll"));
      });
      await page.waitForFunction(
        (firstBefore) => {
          const firstNow = document.querySelector('[data-list="left"] [data-entry-path]')?.getAttribute("data-entry-path") || "";
          return firstNow && firstNow !== firstBefore;
        },
        beforeScroll.first,
        { timeout: 5000 }
      );
      return inspectVirtualList(page, count);
    });
    assert(
      scroll.result.renderedRows > 0 && scroll.result.renderedRows < 500,
      `Scrolled virtual list should keep a bounded row window, got ${scroll.result.renderedRows}.`
    );
  }

  const screenshot = path.join(artifactsDir, `${screenshotPrefix()}-${viewport.name}${options.evidenceSuffix || ""}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  return {
    viewport,
    screenshot,
    navigateMs: navigate.wallMs,
    firstWindowPaintMs: firstWindowPaint?.wallMs ?? null,
    fullHydrationMs: fullHydration?.wallMs ?? null,
    windowFirst,
    listingRequests: windowProbe.requests.map((request) => ({
      isWindow: request.isWindow,
      offset: request.offset,
      limit: request.limit,
      format: request.format
    })),
    header,
    virtualInitial,
    filterMs: filter?.wallMs ?? null,
    filterResult: filter?.result ?? null,
    scrollMs: scroll?.wallMs ?? null,
    scrollResult: scroll?.result ?? null,
    consoleErrors,
    pageErrors
  };
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const count = countOption();
  const repetitions = repetitionCount(count);
  const fixtureOption = optionValue("--fixture", process.env.EB_LARGE_UI_FIXTURE || "");
  const fixture = fixtureOption ? path.resolve(fixtureOption) : await prepareFixture(count);
  if (fixtureOption) {
    await fs.access(fixture);
  }
  await fs.mkdir(appData, { recursive: true });
  const port = Number(optionValue("--port", process.env.PORT || "49331"));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData,
      EXPLORE_BETTER_NATIVE_HELPER_WARMUP: "1"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
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
    browser = await chromium.launch({ executablePath: edgePath(), headless: true });
    const reports = [];
    const activeViewports = selectedViewports();
    for (const [index, viewport] of activeViewports.entries()) {
      const samples = [];
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        const page = await browser.newPage();
        try {
          samples.push(
            await runViewport(page, baseUrl, fixture, viewport, count, {
              bypassCache: repetitions > 1,
              enforcePerformance: repetitions === 1,
              exerciseInteractions: index === 0 && repetition === 0,
              evidenceSuffix: repetitions > 1 ? `-run-${repetition + 1}` : ""
            })
          );
        } finally {
          await page.close().catch(() => {});
        }
      }
      const report = {
        ...samples[0],
        navigateMs: median(samples.map((sample) => sample.navigateMs)),
        firstWindowPaintMs: median(samples.map((sample) => sample.firstWindowPaintMs)),
        fullHydrationMs: median(samples.map((sample) => sample.fullHydrationMs)),
        consoleErrors: samples.flatMap((sample) => sample.consoleErrors),
        pageErrors: samples.flatMap((sample) => sample.pageErrors),
        repetitions: samples.map((sample, repetition) => ({
          repetition: repetition + 1,
          navigateMs: sample.navigateMs,
          firstWindowPaintMs: sample.firstWindowPaintMs,
          fullHydrationMs: sample.fullHydrationMs,
          windowRows: sample.windowFirst?.renderedRows || 0,
          virtualRows: sample.virtualInitial?.renderedRows || 0,
          screenshot: sample.screenshot
        }))
      };
      if (count >= 100000) {
        assert(
          Number(report.firstWindowPaintMs || Infinity) <= 750,
          `${viewport.name}: median cold first visible window must paint within 750ms, got ${report.firstWindowPaintMs}ms.`
        );
        assert(
          Number(report.fullHydrationMs || Infinity) <= 2000,
          `${viewport.name}: median cold full hydration must finish within 2000ms, got ${report.fullHydrationMs}ms.`
        );
      }
      reports.push(report);
      console.log(
        `${viewport.name}: ${repetitions} run median first paint ${report.firstWindowPaintMs} ms, hydration ${report.fullHydrationMs} ms, virtualized ${report.virtualInitial.renderedRows} rendered row(s)`
      );
    }

    const coldList = await timed("api-cold-list", async () =>
      requestJson(baseUrl, `/api/list?path=${encodeURIComponent(fixture)}&showHidden=true&bypassCache=true`)
    );
    const warmList = await timed("api-warm-list", async () =>
      requestJson(baseUrl, `/api/list?path=${encodeURIComponent(fixture)}&showHidden=true`)
    );
    const compactWarmList = await timed("api-compact-v2-warm-list", async () =>
      requestJson(baseUrl, `/api/list?path=${encodeURIComponent(fixture)}&showHidden=true&format=compact-v2`)
    );
    assert(coldList.result.entries.length >= count, `API cold list should return at least ${count} entries.`);
    assert(warmList.result.entries.length >= count, `API warm list should return at least ${count} entries.`);
    assert(compactWarmList.result.entryRows.length >= count, `API compact-v2 warm list should return at least ${count} rows.`);

    const consoleErrors = reports.flatMap((report) =>
      report.consoleErrors.map((message) => ({ viewport: report.viewport.name, message }))
    );
    const pageErrors = reports.flatMap((report) =>
      report.pageErrors.map((message) => ({ viewport: report.viewport.name, message }))
    );
    assert(consoleErrors.length === 0, `Browser console errors: ${JSON.stringify(consoleErrors)}`);
    assert(pageErrors.length === 0, `Browser page errors: ${JSON.stringify(pageErrors)}`);

    const output = {
      generatedAt: new Date().toISOString(),
      count,
      repetitions,
      fixture,
      api: {
        coldWallMs: coldList.wallMs,
        warmWallMs: warmList.wallMs,
        compactV2WarmWallMs: compactWarmList.wallMs,
        coldTiming: coldList.result.timing,
        warmTiming: warmList.result.timing,
        compactV2WarmTiming: compactWarmList.result.timing
      },
      reports
    };
    const outputPath = path.join(artifactsDir, outputName());
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");
    console.log(`api cold ${coldList.wallMs} ms, warm ${warmList.wallMs} ms, compact-v2 warm ${compactWarmList.wallMs} ms`);
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
