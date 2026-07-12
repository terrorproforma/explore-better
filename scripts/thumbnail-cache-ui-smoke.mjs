import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `thumbnail-cache-ui-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "thumbnail-cache-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "thumbnail-cache-ui-latest.md");
const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function countOption() {
  const value = Number(optionValue("--count", process.env.EB_THUMBNAIL_UI_COUNT || "2400"));
  return Number.isInteger(value) && value > 0 ? value : 2400;
}

function edgePath() {
  return (
    optionValue("--browser", process.env.EB_THUMBNAIL_UI_BROWSER || "") ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  );
}

async function requestJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function waitForServer(baseUrl, child, serverOutputRef) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${serverOutputRef()}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}: ${serverOutputRef()}`);
}

async function writeBatch(files) {
  await Promise.all(files.map((file) => fs.writeFile(file, png1x1)));
}

async function prepareFixture(count) {
  await fs.mkdir(fixture, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  const files = [];
  for (let index = 0; index < count; index += 1) {
    files.push(path.join(fixture, `photo-${String(index).padStart(5, "0")}.png`));
    if (files.length >= 400) {
      await writeBatch(files.splice(0));
    }
  }
  if (files.length) {
    await writeBatch(files);
  }
  await fs.writeFile(path.join(fixture, "notes.txt"), "non-image control\n");
  return path.join(fixture, "photo-00000.png");
}

function rawUrl(baseUrl, file, stats) {
  const query = new URLSearchParams({ path: file, v: `${stats.size}-${Math.round(stats.mtimeMs)}` });
  return `${baseUrl}/api/raw?${query}`;
}

async function requestRaw(baseUrl, file, headers = {}) {
  const stats = await fs.stat(file);
  const response = await fetch(rawUrl(baseUrl, file, stats), { headers });
  const bytes = response.status === 304 ? 0 : (await response.arrayBuffer()).byteLength;
  const contentLength = Number(response.headers.get("content-length") || bytes || 0);
  return {
    status: response.status,
    ok: response.ok || response.status === 304,
    bytes,
    contentLength,
    contentRange: response.headers.get("content-range") || "",
    etag: response.headers.get("etag") || "",
    lastModified: response.headers.get("last-modified") || "",
    cacheControl: response.headers.get("cache-control") || "",
    contentType: response.headers.get("content-type") || "",
    acceptRanges: response.headers.get("accept-ranges") || "",
    url: rawUrl(baseUrl, file, stats)
  };
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function waitForNodeCondition(fn, label, timeoutMs = 10000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last?.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

async function inspectTilePane(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-list="left"]');
    const tiles = [...document.querySelectorAll('.pane[data-pane="left"] .file-tile[data-entry-path]')];
    const images = [...document.querySelectorAll('.pane[data-pane="left"] .tile-thumb-image')];
    return {
      viewTiles: list?.classList.contains("view-tiles") === true,
      virtualized: list?.classList.contains("virtualized") === true,
      renderedTiles: tiles.length,
      renderedImages: images.length,
      loadedImages: images.filter((image) => image.classList.contains("loaded")).length,
      loadingImages: images.filter((image) => image.classList.contains("loading")).length,
      errorImages: images.filter((image) => image.classList.contains("error")).length,
      pendingImages: images.filter((image) => image.hasAttribute("data-thumb-src")).length,
      firstPath: tiles[0]?.getAttribute("data-entry-path") || "",
      lastPath: tiles.at(-1)?.getAttribute("data-entry-path") || "",
      listClientHeight: list?.clientHeight || 0,
      listScrollHeight: list?.scrollHeight || 0,
      statusText: document.getElementById("status-pill")?.textContent?.trim() || ""
    };
  });
}

function rawPathFromUrl(rawUrlValue) {
  try {
    const parsed = new URL(rawUrlValue);
    return parsed.pathname === "/api/raw" ? parsed.searchParams.get("path") || "" : "";
  } catch {
    return "";
  }
}

function rawStats(requests, responses) {
  const uniquePaths = new Set(requests.map((item) => item.path).filter(Boolean));
  const versioned = requests.filter((item) => item.versioned).length;
  const statuses = responses.reduce((counts, item) => {
    counts[item.status] = (counts[item.status] || 0) + 1;
    return counts;
  }, {});
  return {
    requests: requests.length,
    responses: responses.length,
    uniquePaths: uniquePaths.size,
    versioned,
    statuses
  };
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Thumbnail Cache UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Raw Cache And Range Streaming

| Probe | Status | Bytes | Detail |
| --- | ---: | ---: | --- |
| First full stream | ${report.cache?.firstRaw?.status || "?"} | ${report.cache?.firstRaw?.bytes || 0} | ${report.cache?.firstRaw?.cacheControl || ""} |
| Conditional stream | ${report.cache?.conditionalRaw?.status || "?"} | ${report.cache?.conditionalRaw?.bytes || 0} | etag=${Boolean(report.cache?.firstRaw?.etag)} |
| Bounded range | ${report.cache?.rangeRaw?.status || "?"} | ${report.cache?.rangeRaw?.bytes || 0} | ${report.cache?.rangeRaw?.contentRange || ""} |
| Suffix range | ${report.cache?.suffixRangeRaw?.status || "?"} | ${report.cache?.suffixRangeRaw?.bytes || 0} | ${report.cache?.suffixRangeRaw?.contentRange || ""} |
| Invalid range | ${report.cache?.invalidRangeRaw?.status || "?"} | ${report.cache?.invalidRangeRaw?.bytes || 0} | ${report.cache?.invalidRangeRaw?.contentRange || ""} |
| Conditional herd | ${report.cache?.conditionalHerd?.notModified || 0}/${report.cache?.conditionalHerd?.count || 0} | 0 | statuses=${JSON.stringify(report.cache?.conditionalHerd?.statuses || {})} |

## Browser Raw Requests

| Phase | Unique raw paths | Requests | Rendered tiles | Loaded images |
| --- | ---: | ---: | ---: | ---: |
| Initial tiles | ${report.tiles.initialRaw.uniquePaths} | ${report.tiles.initialRaw.requests} | ${report.tiles.initial.renderedTiles} | ${report.tiles.initial.loadedImages} |
| After scroll | ${report.tiles.afterScrollRaw.uniquePaths} | ${report.tiles.afterScrollRaw.requests} | ${report.tiles.afterScroll.renderedTiles} | ${report.tiles.afterScroll.loadedImages} |
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const count = countOption();
  const firstImage = await prepareFixture(count);
  const port = Number(optionValue("--port", process.env.PORT || 48000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const consoleMessages = [];
  const pageErrors = [];
  const rawRequests = [];
  const rawResponses = [];
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  let browser = null;
  let cache = null;
  const tiles = {};
  try {
      await waitForServer(baseUrl, server, () => serverOutput);
    const firstRaw = await requestRaw(baseUrl, firstImage);
    const conditionalRaw = await requestRaw(baseUrl, firstImage, { "if-none-match": firstRaw.etag });
    const rangeRaw = await requestRaw(baseUrl, firstImage, { range: "bytes=0-15" });
    const suffixRangeRaw = await requestRaw(baseUrl, firstImage, { range: "bytes=-8" });
    const invalidRangeRaw = await requestRaw(baseUrl, firstImage, { range: "bytes=999999-" });
    const conditionalHerdResponses = await Promise.all(
      Array.from({ length: 8 }, () => requestRaw(baseUrl, firstImage, { "if-none-match": firstRaw.etag }))
    );
    const conditionalHerd = {
      count: conditionalHerdResponses.length,
      notModified: conditionalHerdResponses.filter((item) => item.status === 304 && item.bytes === 0).length,
      statuses: conditionalHerdResponses.reduce((counts, item) => {
        counts[item.status] = (counts[item.status] || 0) + 1;
        return counts;
      }, {})
    };
    cache = { firstRaw, conditionalRaw, rangeRaw, suffixRangeRaw, invalidRangeRaw, conditionalHerd };

    browser = await chromium.launch({ executablePath: edgePath(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        consoleMessages.push({ type: message.type(), text: message.text() });
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });
    page.on("request", (request) => {
      const requestUrl = request.url();
      const requestPath = rawPathFromUrl(requestUrl);
      if (!requestPath) return;
      const parsed = new URL(requestUrl);
      rawRequests.push({
        url: requestUrl,
        path: requestPath,
        versioned: parsed.searchParams.has("v")
      });
    });
    page.on("response", (response) => {
      const requestPath = rawPathFromUrl(response.url());
      if (!requestPath) return;
      rawResponses.push({
        path: requestPath,
        status: response.status(),
        cacheControl: response.headers()["cache-control"] || "",
        etag: response.headers().etag || ""
      });
    });

    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 30000 });
    await page.locator('[data-view-mode="tiles"][data-pane="left"]').click();
    await page.waitForFunction(
      () => document.querySelector('[data-list="left"]')?.classList.contains("view-tiles"),
      { timeout: 10000 }
    );
    await waitForNodeCondition(
      () => ({ ok: rawResponses.length >= 1, raw: rawStats(rawRequests, rawResponses) }),
      "initial thumbnail raw response",
      10000
    );
    await page.waitForTimeout(600);
    tiles.initial = await inspectTilePane(page);
    tiles.initialRaw = rawStats(rawRequests, rawResponses);

    await page.evaluate(() => {
      const list = document.querySelector('[data-list="left"]');
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event("scroll"));
    });
    await waitForNodeCondition(
      () => {
        const stats = rawStats(rawRequests, rawResponses);
        return { ok: stats.uniquePaths > tiles.initialRaw.uniquePaths, raw: stats };
      },
      "scroll loaded additional thumbnail raw responses",
      10000
    );
    await page.waitForTimeout(400);
    tiles.afterScroll = await inspectTilePane(page);
    tiles.afterScrollRaw = rawStats(rawRequests, rawResponses);

    check(
      checks,
      "raw-cache-headers",
      firstRaw.status === 200 &&
        firstRaw.bytes > 0 &&
        /immutable/i.test(firstRaw.cacheControl) &&
        Boolean(firstRaw.etag) &&
        Boolean(firstRaw.lastModified) &&
        firstRaw.acceptRanges === "bytes",
      `status=${firstRaw.status}; bytes=${firstRaw.bytes}; cache=${firstRaw.cacheControl}; etag=${Boolean(firstRaw.etag)}.`
    );
    check(
      checks,
      "raw-conditional-304",
      conditionalRaw.status === 304 && conditionalRaw.bytes === 0,
      `conditional status=${conditionalRaw.status}; bytes=${conditionalRaw.bytes}.`
    );
    check(
      checks,
      "raw-range-206",
      rangeRaw.status === 206 &&
        rangeRaw.bytes === Math.min(16, firstRaw.bytes) &&
        rangeRaw.contentLength === rangeRaw.bytes &&
        rangeRaw.contentRange === `bytes 0-${rangeRaw.bytes - 1}/${firstRaw.bytes}` &&
        rangeRaw.acceptRanges === "bytes",
      `range status=${rangeRaw.status}; bytes=${rangeRaw.bytes}; contentRange=${rangeRaw.contentRange}.`
    );
    check(
      checks,
      "raw-suffix-range-206",
      suffixRangeRaw.status === 206 &&
        suffixRangeRaw.bytes === Math.min(8, firstRaw.bytes) &&
        suffixRangeRaw.contentLength === suffixRangeRaw.bytes &&
        suffixRangeRaw.contentRange.endsWith(`/${firstRaw.bytes}`) &&
        suffixRangeRaw.acceptRanges === "bytes",
      `suffix status=${suffixRangeRaw.status}; bytes=${suffixRangeRaw.bytes}; contentRange=${suffixRangeRaw.contentRange}.`
    );
    check(
      checks,
      "raw-invalid-range-416",
      invalidRangeRaw.status === 416 && invalidRangeRaw.contentRange === `bytes */${firstRaw.bytes}`,
      `invalid status=${invalidRangeRaw.status}; contentRange=${invalidRangeRaw.contentRange}.`
    );
    check(
      checks,
      "raw-conditional-herd-304",
      conditionalHerd.notModified === conditionalHerd.count,
      `notModified=${conditionalHerd.notModified}/${conditionalHerd.count}; statuses=${JSON.stringify(conditionalHerd.statuses)}.`
    );
    check(
      checks,
      "tile-view-virtualized",
      tiles.initial.viewTiles && tiles.initial.virtualized && tiles.initial.renderedTiles > 0 && tiles.initial.renderedTiles < count,
      `viewTiles=${tiles.initial.viewTiles}; virtualized=${tiles.initial.virtualized}; rendered=${tiles.initial.renderedTiles}/${count}.`
    );
    check(
      checks,
      "initial-thumbnails-lazy-bounded",
      tiles.initialRaw.uniquePaths > 0 && tiles.initialRaw.uniquePaths < count * 0.35,
      `initial raw unique=${tiles.initialRaw.uniquePaths}/${count}; requests=${tiles.initialRaw.requests}.`
    );
    check(
      checks,
      "thumbnail-urls-versioned",
      tiles.initialRaw.versioned === tiles.initialRaw.requests && tiles.initialRaw.requests > 0,
      `versioned=${tiles.initialRaw.versioned}/${tiles.initialRaw.requests}.`
    );
    check(
      checks,
      "thumbnail-loads-without-errors",
      tiles.initial.loadedImages > 0 && tiles.afterScroll.errorImages === 0 && pageErrors.length === 0,
      `loaded initial=${tiles.initial.loadedImages}; after-scroll errors=${tiles.afterScroll.errorImages}; pageErrors=${pageErrors.length}.`
    );
    check(
      checks,
      "scroll-loads-more-thumbnails",
      tiles.afterScrollRaw.uniquePaths > tiles.initialRaw.uniquePaths && tiles.afterScrollRaw.uniquePaths < count,
      `raw unique after scroll=${tiles.afterScrollRaw.uniquePaths}; initial=${tiles.initialRaw.uniquePaths}; total=${count}.`
    );
    check(
      checks,
      "virtual-scroll-keeps-dom-bounded",
      tiles.afterScroll.renderedTiles > 0 && tiles.afterScroll.renderedTiles < count * 0.35,
      `rendered after scroll=${tiles.afterScroll.renderedTiles}/${count}.`
    );
    check(checks, "browser-console-clean", pageErrors.length === 0, `${pageErrors.length} page error(s).`);
  } catch (error) {
    check(checks, "smoke-execution", false, error.message);
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }

  const summary = {
    pass: checks.filter((item) => item.status === "pass").length,
    warn: checks.filter((item) => item.status === "warn").length,
    fail: checks.filter((item) => item.status === "fail").length
  };
  const report = {
    generatedAt: new Date().toISOString(),
    status: summary.fail ? "fail" : "pass",
    count,
    baseUrl,
    fixture,
    cache,
    tiles,
    consoleMessages,
    pageErrors,
    serverOutput: serverOutput.slice(-4000),
    summary,
    checks
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(latestMdPath, markdownReport(report));
  console.log(`thumbnail cache UI smoke: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
