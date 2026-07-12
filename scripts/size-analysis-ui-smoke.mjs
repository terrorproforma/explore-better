import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `size-analysis-ui-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "size-analysis-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "size-analysis-ui-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function edgePath() {
  return optionValue("--browser", process.env.EB_SIZE_ANALYSIS_BROWSER || "") || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
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
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function waitForServer(baseUrl, child, getOutput) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${getOutput()}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}: ${getOutput()}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1500);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function writeSizedFile(filePath, bytes, fill = 65) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.alloc(bytes, fill));
}

async function prepareFixture() {
  await writeSizedFile(path.join(fixture, "media", "movie.mkv"), 360 * 1024, 77);
  await writeSizedFile(path.join(fixture, "media", "clip.mp4"), 160 * 1024, 80);
  await writeSizedFile(path.join(fixture, "photos", "cover.jpg"), 110 * 1024, 74);
  await writeSizedFile(path.join(fixture, "archives", "backup.zip"), 92 * 1024, 90);
  await writeSizedFile(path.join(fixture, "docs", "manual.pdf"), 62 * 1024, 68);
  await writeSizedFile(path.join(fixture, "docs", "notes.txt"), 8 * 1024, 84);
  await fs.mkdir(appData, { recursive: true });
}

async function inspectAnalyzer(page) {
  return page.evaluate(() => {
    const textList = (selector) => [...document.querySelectorAll(selector)].map((element) => element.textContent.trim().replace(/\s+/g, " "));
    const canvas = document.getElementById("size-analysis-treemap");
    const context = canvas?.getContext?.("2d");
    let coloredPixels = 0;
    if (canvas && context) {
      const width = canvas.width;
      const height = canvas.height;
      const data = context.getImageData(0, 0, width, height).data;
      for (let index = 0; index < data.length; index += 40) {
        const red = data[index];
        const green = data[index + 1];
        const blue = data[index + 2];
        if (!(red > 225 && green > 228 && blue > 225)) {
          coloredPixels += 1;
        }
      }
    }
    const dialog = document.getElementById("size-analysis-dialog");
    const layoutIssues = [];
    for (const element of dialog?.querySelectorAll("button, input, label, .size-analysis-metric, .size-analysis-row") || []) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) continue;
      const formControl = element.matches("input, textarea, select");
      const tinyControl = element.matches('input[type="checkbox"], input[type="radio"]');
      const clipped = !formControl && (element.scrollWidth > element.clientWidth + 6 || element.scrollHeight > element.clientHeight + 6);
      const squished = tinyControl ? rect.width < 14 || rect.height < 14 : rect.width < 24 || rect.height < 14;
      if (clipped || squished) {
        layoutIssues.push({
          tag: element.tagName.toLowerCase(),
          text: (element.textContent || element.value || "").trim().replace(/\s+/g, " ").slice(0, 80),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          clipped,
          squished
        });
      }
    }
    const scrollIssues = [];
    for (const element of dialog?.querySelectorAll(
      ".size-analysis-panel, .size-analysis-scan-strip, .size-analysis-progress-track, .size-analysis-main, .size-analysis-map-row, .size-analysis-table-panel, .size-analysis-table-body"
    ) || []) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) continue;
      if (element.scrollWidth > element.clientWidth + 8 || element.scrollHeight > element.clientHeight + 8) {
        scrollIssues.push({
          className: element.className || element.id || element.tagName.toLowerCase(),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          scrollWidth: element.scrollWidth,
          scrollHeight: element.scrollHeight
        });
      }
    }
    return {
      summary: document.getElementById("size-analysis-summary")?.textContent?.trim() || "",
      mapDetail: document.getElementById("size-analysis-map-detail")?.textContent?.trim().replace(/\s+/g, " ") || "",
      scanStrip: document.getElementById("size-analysis-scan-strip")?.textContent?.trim().replace(/\s+/g, " ") || "",
      metrics: textList("#size-analysis-metrics .size-analysis-metric"),
      folders: textList("#size-analysis-folders .size-analysis-row"),
      files: textList("#size-analysis-files .size-analysis-row"),
      extensions: textList("#size-analysis-extensions .size-analysis-row"),
      heads: textList(".size-analysis-table-head"),
      swatches: [...document.querySelectorAll("#size-analysis-extensions .size-analysis-type-cell i")].map((element) =>
        getComputedStyle(element).backgroundColor
      ),
      bands: [...document.querySelectorAll("#size-analysis-scan-strip .size-analysis-band-segment")].map((element) => ({
        color: getComputedStyle(element).backgroundColor,
        width: Math.round(element.getBoundingClientRect().width)
      })),
      canvas: {
        width: canvas?.width || 0,
        height: canvas?.height || 0,
        coloredPixels,
        title: canvas?.title || "",
        ariaLabel: canvas?.getAttribute("aria-label") || ""
      },
      selectedEntries: [...document.querySelectorAll('.pane[data-pane="left"] [data-entry-path][aria-selected="true"]')].map(
        (element) => element.dataset.entryPath || ""
      ),
      layoutIssues,
      scrollIssues
    };
  });
}

async function hoverTreemapFile(page, fileName) {
  const canvas = page.locator("#size-analysis-treemap");
  const box = await canvas.boundingBox();
  if (!box) {
    return null;
  }
  const samplePoints = [
    [0.05, 0.08],
    [0.12, 0.18],
    [0.2, 0.3],
    [0.35, 0.22],
    [0.55, 0.25],
    [0.75, 0.25],
    [0.9, 0.4],
    [0.45, 0.65],
    [0.18, 0.78]
  ];
  for (const [xShare, yShare] of samplePoints) {
    const x = box.x + box.width * xShare;
    const y = box.y + box.height * yShare;
    await page.mouse.move(x, y);
    await page.waitForTimeout(40);
    const detail = await page.locator("#size-analysis-map-detail").textContent().catch(() => "");
    if (detail && detail.toLowerCase().includes(fileName.toLowerCase())) {
      return { x, y, detail: detail.trim().replace(/\s+/g, " ") };
    }
  }
  return null;
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Size Analysis UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 50000 + Math.floor(Math.random() * 9000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const pageErrors = [];
  const consoleMessages = [];
  const failedResponses = [];
  let serverOutput = "";
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
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
  let ui = null;
  let apiReport = null;
  let treemapHit = null;
  let screenshot = null;
  let cancelProbe = null;
  try {
    await waitForServer(baseUrl, server, () => serverOutput);
    apiReport = await requestJson(baseUrl, "/api/size-analysis", {
      method: "POST",
      body: JSON.stringify({ path: fixture, maxEntries: 10000 })
    });
    browser = await chromium.launch({ executablePath: edgePath(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        consoleMessages.push({ type: message.type(), text: message.text() });
      }
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        failedResponses.push({ status: response.status(), url: response.url() });
      }
    });
    let releaseCanceledRoute = null;
    let settleCanceledRoute = null;
    const routeSettled = new Promise((resolve) => {
      settleCanceledRoute = resolve;
    });
    cancelProbe = {
      intercepted: false,
      released: false,
      fulfilled: false,
      fulfillError: "",
      during: null,
      after: null
    };
    await page.route("**/api/size-analysis", async (route) => {
      if (!cancelProbe.intercepted) {
        cancelProbe.intercepted = true;
        try {
          await new Promise((resolve) => {
            releaseCanceledRoute = resolve;
          });
          cancelProbe.released = true;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              generatedAt: new Date().toISOString(),
              path: fixture,
              requestedPath: fixture,
              followLinks: false,
              maxEntries: 10000,
              scanned: 0,
              truncated: false,
              skipped: [],
              space: null,
              summary: { bytes: 0, files: 0, folders: 0, extensions: 0, skipped: 0, elapsedMs: 0 },
              tree: null,
              topFolders: [],
              topFiles: [],
              extensions: [],
              cache: { hit: false, source: "ui-cancel-probe" }
            })
          });
          cancelProbe.fulfilled = true;
        } catch (error) {
          cancelProbe.fulfillError = error.message;
        } finally {
          settleCanceledRoute();
        }
        return;
      }
      await route.continue();
    });
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    await page.locator('[data-global-action="sizeAnalysis"]').click();
    await page.waitForSelector("#size-analysis-dialog[open]", { timeout: 10000 });

    await page.locator('[data-size-analysis-action="scan"]').click();
    await page.waitForFunction(
      () =>
        document.getElementById("size-analysis-dialog")?.open &&
        document.getElementById("size-analysis-cancel")?.disabled === false &&
        document.getElementById("size-analysis-path")?.disabled === true,
      null,
      { timeout: 10000 }
    );
    cancelProbe.during = await page.evaluate(() => ({
      summary: document.getElementById("size-analysis-summary")?.textContent?.trim() || "",
      cancelDisabled: document.getElementById("size-analysis-cancel")?.disabled ?? true,
      scanDisabled: document.querySelector('[data-size-analysis-action="scan"]')?.disabled ?? false,
      pathDisabled: document.getElementById("size-analysis-path")?.disabled ?? false,
      strip: document.getElementById("size-analysis-scan-strip")?.textContent?.trim().replace(/\s+/g, " ") || ""
    }));
    await page.locator('[data-size-analysis-action="cancel"]').click();
    await page.waitForFunction(
      () =>
        /canceled/i.test(document.getElementById("size-analysis-summary")?.textContent || "") &&
        document.getElementById("size-analysis-cancel")?.disabled === true &&
        document.querySelector('[data-size-analysis-action="scan"]')?.disabled === false &&
        document.getElementById("size-analysis-path")?.disabled === false,
      null,
      { timeout: 10000 }
    );
    cancelProbe.after = await page.evaluate(() => ({
      summary: document.getElementById("size-analysis-summary")?.textContent?.trim() || "",
      cancelDisabled: document.getElementById("size-analysis-cancel")?.disabled ?? false,
      scanDisabled: document.querySelector('[data-size-analysis-action="scan"]')?.disabled ?? true,
      pathDisabled: document.getElementById("size-analysis-path")?.disabled ?? true,
      strip: document.getElementById("size-analysis-scan-strip")?.textContent?.trim().replace(/\s+/g, " ") || ""
    }));
    releaseCanceledRoute?.();
    await Promise.race([routeSettled, page.waitForTimeout(500)]);
    await page.unroute("**/api/size-analysis").catch(() => {});

    await page.locator('[data-size-analysis-action="scan"]').click();
    await page.waitForFunction(
      () => {
        const summary = document.getElementById("size-analysis-summary")?.textContent || "";
        return !/Scanning/i.test(summary) && /file/i.test(summary);
      },
      null,
      { timeout: 10000 }
    );
    treemapHit = await hoverTreemapFile(page, "movie.mkv");
    if (treemapHit) {
      await page.mouse.click(treemapHit.x, treemapHit.y);
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('.pane[data-pane="left"] [data-entry-path][aria-selected="true"]')].some((element) =>
            /movie\.mkv$/i.test(element.dataset.entryPath || "")
          ),
        null,
        { timeout: 10000 }
      );
    }
    ui = await inspectAnalyzer(page);
    screenshot = path.join(artifactsDir, "size-analysis-ui-latest.png");
    await page.screenshot({ path: screenshot, fullPage: true });

    check(checks, "api-summary-bytes", Number(apiReport.summary?.bytes || 0) > 700000, `${apiReport.summary?.bytes || 0} bytes`);
    check(
      checks,
      "api-allocated-summary",
      Number(apiReport.summary?.allocated || 0) >= Number(apiReport.summary?.bytes || 0),
      `${apiReport.summary?.allocated || 0}/${apiReport.summary?.bytes || 0} allocated/logical bytes`
    );
    check(
      checks,
      "api-extension-allocated-category",
      (apiReport.extensions || []).some(
        (item) =>
          item.extension === ".mkv" &&
          Number(item.allocated || 0) >= Number(item.size || 0) &&
          typeof item.category === "string" &&
          item.category.length > 0
      ),
      JSON.stringify((apiReport.extensions || []).slice(0, 6))
    );
    check(checks, "ui-cancel-request-intercepted", cancelProbe.intercepted === true, JSON.stringify(cancelProbe));
    check(
      checks,
      "ui-cancel-enabled-while-scanning",
      cancelProbe.during?.cancelDisabled === false && cancelProbe.during?.scanDisabled === true && cancelProbe.during?.pathDisabled === true,
      JSON.stringify(cancelProbe.during || null)
    );
    check(
      checks,
      "ui-cancel-restores-controls",
      /canceled/i.test(cancelProbe.after?.summary || "") &&
        cancelProbe.after?.cancelDisabled === true &&
        cancelProbe.after?.scanDisabled === false &&
        cancelProbe.after?.pathDisabled === false,
      JSON.stringify(cancelProbe.after || null)
    );
    check(
      checks,
      "api-space-context",
      apiReport.space?.available === true && Number(apiReport.space?.totalBytes || 0) > 0,
      JSON.stringify(apiReport.space || null)
    );
    check(checks, "ui-summary-ready", /file/i.test(ui.summary), ui.summary);
    check(checks, "ui-scan-strip-complete", /Scan complete/i.test(ui.scanStrip), ui.scanStrip);
    check(checks, "ui-drive-metric", ui.metrics.some((row) => /Drive Free/i.test(row)), ui.metrics.join(" | "));
    check(checks, "ui-allocated-metric", ui.metrics.some((row) => /Allocated/i.test(row)), ui.metrics.join(" | "));
    check(checks, "ui-top-folder-media", ui.folders.some((row) => row.includes("media")), ui.folders.slice(0, 4).join(" | "));
    check(checks, "ui-top-file-mkv", ui.files.some((row) => row.includes("movie.mkv")), ui.files.slice(0, 4).join(" | "));
    check(checks, "ui-extension-mkv", ui.extensions.some((row) => row.includes(".mkv")), ui.extensions.slice(0, 6).join(" | "));
    check(checks, "ui-extension-jpg", ui.extensions.some((row) => row.includes(".jpg")), ui.extensions.slice(0, 6).join(" | "));
    check(checks, "ui-extension-swatches", ui.swatches.length >= 4, ui.swatches.slice(0, 6).join(" | "));
    check(checks, "ui-extension-band-chart", ui.bands.length >= 4, JSON.stringify(ui.bands.slice(0, 6)));
    check(
      checks,
      "ui-table-heads",
      ui.heads.some((row) => row.includes("Parent") && row.includes("Size")) &&
        ui.heads.some((row) => row.includes("Percent") && row.includes("Files")) &&
        ui.heads.some((row) => row.includes("Allocated")),
      ui.heads.join(" | ")
    );
    check(
      checks,
      "ui-treemap-painted",
      ui.canvas.width > 0 && ui.canvas.height > 0 && ui.canvas.coloredPixels > 500,
      JSON.stringify(ui.canvas)
    );
    check(
      checks,
      "ui-treemap-hover-detail",
      Boolean(treemapHit?.detail) && /movie\.mkv/i.test(treemapHit.detail) && /360\.0 KB/i.test(treemapHit.detail),
      treemapHit?.detail || ui.mapDetail
    );
    check(
      checks,
      "ui-treemap-click-selects-file",
      ui.selectedEntries.some((entryPath) => /movie\.mkv$/i.test(entryPath)),
      ui.selectedEntries.join(" | ")
    );
    check(
      checks,
      "ui-treemap-accessible-label",
      /mapped file block/i.test(ui.canvas.ariaLabel),
      ui.canvas.ariaLabel
    );
    check(checks, "ui-layout-clean", ui.layoutIssues.length === 0, `${ui.layoutIssues.length} clipped/squished analyzer control(s).`);
    check(checks, "ui-no-inner-scrollbars", ui.scrollIssues.length === 0, `${ui.scrollIssues.length} internal analyzer overflow issue(s).`);
    check(checks, "browser-console-clean", pageErrors.length === 0, `${pageErrors.length} page error(s).`);
  } catch (error) {
    check(checks, "smoke-execution", false, `${error.message}; failed responses: ${JSON.stringify(failedResponses.slice(-10))}`);
  } finally {
    await browser?.close().catch(() => {});
    await stopServer(server);
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }

  const summary = {
    pass: checks.filter((item) => item.status === "pass").length,
    fail: checks.filter((item) => item.status === "fail").length
  };
  const report = {
    generatedAt: new Date().toISOString(),
    status: summary.fail ? "fail" : "pass",
    baseUrl,
    fixture,
    screenshot,
    treemapHit,
    apiReport,
    ui,
    cancelProbe,
    pageErrors,
    consoleMessages,
    failedResponses,
    serverOutput: serverOutput.slice(-4000),
    checks,
    summary
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(latestMdPath, markdownReport(report));
  console.log(`size analysis UI smoke: ${summary.pass} pass, ${summary.fail} fail`);
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
