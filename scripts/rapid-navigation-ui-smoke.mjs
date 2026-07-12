import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `rapid-navigation-ui-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const slowFolder = path.join(fixture, "Slow Race Source");
const fastFolder = path.join(fixture, "Fast Final Destination");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "rapid-navigation-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "rapid-navigation-ui-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function edgePath() {
  return (
    optionValue("--browser", process.env.EB_RAPID_NAVIGATION_BROWSER || "") ||
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

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}`);
}

async function prepareFixture() {
  await fs.mkdir(slowFolder, { recursive: true });
  await fs.mkdir(fastFolder, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.writeFile(path.join(fixture, "root-control.txt"), "rapid navigation root\n");
  await fs.writeFile(path.join(slowFolder, "slow-stale-marker.txt"), "this row must never win the race\n");
  await fs.writeFile(path.join(fastFolder, "final-target.txt"), "the final folder must stay rendered\n");
  for (let index = 0; index < 80; index += 1) {
    await fs.writeFile(path.join(slowFolder, `slow-extra-${String(index).padStart(3, "0")}.txt`), "slow\n");
  }
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

async function waitForPageResult(page, fn, label, timeoutMs = 10000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await page.evaluate(fn);
    if (last?.ok) return last;
    await page.waitForTimeout(80);
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

async function navigateLeft(page, targetPath) {
  const input = page.locator('[data-path-input="left"]');
  await input.fill(targetPath);
  await input.press("Enter");
}

async function paneSnapshot(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.pane[data-pane="left"] [data-entry-path]')].map((row) => ({
      text: row.textContent.trim().replace(/\s+/g, " "),
      path: row.getAttribute("data-entry-path") || ""
    }));
    return {
      path: document.querySelector('[data-path-input="left"]')?.value || "",
      statusText: document.getElementById("status-pill")?.textContent?.trim() || "",
      rows,
      rowCount: rows.length,
      finalVisible: rows.some((row) => row.text.includes("final-target.txt")),
      staleVisible: rows.some((row) => row.text.includes("slow-stale-marker.txt")),
      race: window.__ebRapidNavigationRace || null
    };
  });
}

function pathFromRequestUrl(requestUrl) {
  try {
    const parsed = new URL(requestUrl);
    return parsed.pathname === "/api/list" ? parsed.searchParams.get("path") || "" : "";
  } catch {
    return "";
  }
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Rapid Navigation UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Race

| Metric | Value |
| --- | --- |
| Delayed slow requests | ${report.routeStats.delayedSlowRequests} |
| Continued slow requests | ${report.routeStats.continuedSlowRequests} |
| Suppressed abort calls | ${report.navigation?.afterSlowResponse?.race?.suppressedAbortCalls ?? "n/a"} |
| Final path | ${String(report.navigation?.afterSlowResponse?.path || "n/a").replace(/\|/g, "\\|")} |
| Final visible | ${report.navigation?.afterSlowResponse?.finalVisible === true} |
| Stale visible | ${report.navigation?.afterSlowResponse?.staleVisible === true} |
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 48000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const consoleMessages = [];
  const pageErrors = [];
  const routeStats = {
    listRequests: 0,
    delayedSlowRequests: 0,
    continuedSlowRequests: 0,
    failedSlowContinuations: 0,
    failures: [],
    paths: []
  };
  const navigation = {};
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOutput = "";
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
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        consoleMessages.push({ type: message.type(), text: message.text() });
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });
    await page.addInitScript(() => {
      const originalAbort = AbortController.prototype.abort;
      window.__ebSuppressAbortForRaceTest = false;
      window.__ebRapidNavigationRace = { abortCalls: 0, suppressedAbortCalls: 0 };
      AbortController.prototype.abort = function patchedAbort(...args) {
        window.__ebRapidNavigationRace.abortCalls += 1;
        if (window.__ebSuppressAbortForRaceTest) {
          window.__ebRapidNavigationRace.suppressedAbortCalls += 1;
          return undefined;
        }
        return originalAbort.apply(this, args);
      };
    });
    await page.route("**/api/list?**", async (route) => {
      const requestPath = pathFromRequestUrl(route.request().url());
      routeStats.listRequests += 1;
      routeStats.paths.push(requestPath);
      if (routeStats.paths.length > 20) {
        routeStats.paths.shift();
      }
      if (requestPath === slowFolder) {
        routeStats.delayedSlowRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 700));
        try {
          await route.continue();
          routeStats.continuedSlowRequests += 1;
        } catch (error) {
          routeStats.failedSlowContinuations += 1;
          routeStats.failures.push(error.message);
        }
        return;
      }
      try {
        await route.continue();
      } catch (error) {
        routeStats.failures.push(error.message);
      }
    });

    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, {
      waitUntil: "domcontentloaded"
    });
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    await page.evaluate(() => {
      window.__ebSuppressAbortForRaceTest = true;
    });
    const slowResponsePromise = page
      .waitForResponse((response) => pathFromRequestUrl(response.url()) === slowFolder && response.status() === 200, {
        timeout: 10000
      })
      .then((response) => ({ ok: true, status: response.status(), url: response.url() }))
      .catch((error) => ({ ok: false, error: error.message }));

    await navigateLeft(page, slowFolder);
    await waitForNodeCondition(
      () => ({
        ok: routeStats.delayedSlowRequests >= 1,
        delayedSlowRequests: routeStats.delayedSlowRequests,
        paths: routeStats.paths
      }),
      "slow listing request intercepted",
      5000
    );
    navigation.afterSlowDispatch = await paneSnapshot(page);

    await navigateLeft(page, fastFolder);
    navigation.fastVisible = await waitForPageResult(
      page,
      () => {
        const rows = [...document.querySelectorAll('.pane[data-pane="left"] [data-entry-path]')].map((row) =>
          row.textContent.trim().replace(/\s+/g, " ")
        );
        const currentPath = document.querySelector('[data-path-input="left"]')?.value || "";
        return {
          ok: currentPath.endsWith("Fast Final Destination") && rows.some((row) => row.includes("final-target.txt")),
          path: currentPath,
          rows
        };
      },
      "fast folder rendered"
    );

    navigation.slowResponse = await slowResponsePromise;
    await page.waitForTimeout(500);
    navigation.afterSlowResponse = await paneSnapshot(page);
    await page.evaluate(() => {
      window.__ebSuppressAbortForRaceTest = false;
    });

    await page.keyboard.press("Control+F");
    await page.waitForSelector('[data-quick-search-panel="left"]:not([hidden])', { timeout: 10000 });
    await page.keyboard.type("final");
    navigation.quickSearch = await waitForPageResult(
      page,
      () => {
        const rows = [...document.querySelectorAll('.pane[data-pane="left"] [data-entry-path]')].map((row) => ({
          text: row.textContent.trim().replace(/\s+/g, " "),
          path: row.getAttribute("data-entry-path") || ""
        }));
        const countText = document.querySelector('[data-quick-search-count="left"]')?.textContent?.trim() || "";
        return {
          ok: rows.length === 1 && rows[0]?.text.includes("final-target.txt") && /1 match/.test(countText),
          rows,
          countText,
          value: document.querySelector('[data-quick-search-input="left"]')?.value || ""
        };
      },
      "quick search after rapid navigation"
    );

    const finalState = navigation.afterSlowResponse;
    const race = finalState.race || {};
    check(checks, "route-delay-exercised", routeStats.delayedSlowRequests >= 1, `${routeStats.delayedSlowRequests} delayed slow request(s).`);
    check(
      checks,
      "late-slow-response-returned",
      navigation.slowResponse.ok && routeStats.continuedSlowRequests >= 1,
      `Slow response ok=${navigation.slowResponse.ok}; continued=${routeStats.continuedSlowRequests}.`
    );
    check(
      checks,
      "abort-was-attempted",
      Number(race.abortCalls || 0) >= 1 && Number(race.suppressedAbortCalls || 0) >= 1,
      `Abort calls=${race.abortCalls || 0}; suppressed for race=${race.suppressedAbortCalls || 0}.`
    );
    check(
      checks,
      "rapid-final-path",
      finalState.path === fastFolder,
      `Final path was ${finalState.path || "missing"}.`
    );
    check(
      checks,
      "rapid-final-row",
      finalState.finalVisible === true,
      `final-target.txt visible=${finalState.finalVisible}.`
    );
    check(
      checks,
      "rapid-stale-not-visible",
      finalState.staleVisible === false,
      `slow-stale-marker.txt visible=${finalState.staleVisible}.`
    );
    check(
      checks,
      "late-response-did-not-overwrite",
      finalState.path === fastFolder && finalState.finalVisible === true && finalState.staleVisible === false,
      `After delayed response: path=${finalState.path}; rows=${finalState.rowCount}.`
    );
    check(
      checks,
      "quick-search-responsive",
      navigation.quickSearch.rows?.length === 1 && navigation.quickSearch.rows[0]?.text.includes("final-target.txt"),
      `Quick search ${navigation.quickSearch.countText}; value=${navigation.quickSearch.value}.`
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
    baseUrl,
    fixture,
    slowFolder,
    fastFolder,
    navigation,
    routeStats,
    consoleMessages,
    pageErrors,
    serverOutput: serverOutput.slice(-4000),
    summary,
    checks
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(latestMdPath, markdownReport(report));
  console.log(`rapid navigation UI smoke: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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
