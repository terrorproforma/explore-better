import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `server-listing-cache-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "server-listing-cache-latest.json");
const latestMdPath = path.join(artifactsDir, "server-listing-cache-latest.md");
let serverOutput = "";
const onePixelPng = Buffer.from(
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

function numberOption(name, envName, fallback) {
  const value = Number(optionValue(name, process.env[envName] || fallback));
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_SERVER_LISTING_CACHE_KEEP_FIXTURE === "1";
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

function summaryFor(checks) {
  return {
    pass: checks.filter((item) => item.status === "pass").length,
    warn: checks.filter((item) => item.status === "warn").length,
    fail: checks.filter((item) => item.status === "fail").length
  };
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

async function timed(task) {
  const started = performance.now();
  const result = await task();
  return {
    wallMs: Math.round((performance.now() - started) * 10) / 10,
    result
  };
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

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1500);
    server.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function safeRemoveRunRoot() {
  const resolvedRunRoot = path.resolve(runRoot);
  const resolvedArtifacts = path.resolve(artifactsDir);
  if (!resolvedRunRoot.startsWith(`${resolvedArtifacts}${path.sep}`)) {
    throw new Error(`Refusing to remove run root outside artifacts: ${resolvedRunRoot}`);
  }
  await fs.rm(resolvedRunRoot, { recursive: true, force: true });
}

async function prepareFixture(count, imageCount) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const batchSize = 512;
  for (let offset = 0; offset < count; offset += batchSize) {
    const writes = [];
    for (let index = offset; index < Math.min(offset + batchSize, count); index += 1) {
      const name = `server-cache-target-${String(index).padStart(6, "0")}.txt`;
      writes.push(fs.writeFile(path.join(fixtureRoot, name), `server listing cache fixture ${index}\n`, "utf8"));
    }
    await Promise.all(writes);
  }
  for (let index = 0; index < imageCount; index += 1) {
    await fs.writeFile(path.join(fixtureRoot, `server-cache-image-${String(index).padStart(4, "0")}.png`), onePixelPng);
  }
}

async function waitForWatcherChange(baseUrl, fixturePath, sinceVersion, child, timeoutMs = 5000) {
  const started = performance.now();
  let latest = null;
  while (performance.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited while waiting for watcher: ${serverOutput}`);
    }
    latest = await requestJson(
      baseUrl,
      `/api/folder-watch?${new URLSearchParams({ path: fixturePath, since: String(sinceVersion) })}`
    );
    if (latest.available === true && Number(latest.version || 0) > Number(sinceVersion || 0)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return latest;
}

function summarizeList(timing) {
  const data = timing.result || {};
  return {
    wallMs: timing.wallMs,
    returned: data.entries?.length || 0,
    scanned: data.timing?.scanned || 0,
    totalMs: data.timing?.totalMs || 0,
    includeDimensions: data.includeDimensions === true,
    includeLinks: data.includeLinks === true,
    dimensionsCache: data.dimensionsCache || null,
    cache: data.timing?.cache || data.cache || null,
    entries: data.entries || []
  };
}

function markdownReport(report) {
  const cold = report.cold || {};
  const warm = report.warm || {};
  const herd = report.inFlightHerd || {};
  const richCold = report.richCold || {};
  const richWarm = report.richWarm || {};
  const afterChange = report.afterChange || {};
  const postChangeWarm = report.postChangeWarm || {};
  const richAfterChange = report.richAfterChange || {};
  const richPostChangeWarm = report.richPostChangeWarm || {};
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Server Listing Cache Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

Fixture files: ${report.fixture?.totalCount ?? report.fixture?.count ?? "unknown"}
In-flight herd: ${herd.joined ?? "n/a"} joined / ${herd.count ?? "n/a"} requests
Cold wall: ${cold.wallMs ?? "n/a"} ms
Warm wall: ${warm.wallMs ?? "n/a"} ms
Warm scanned: ${warm.scanned ?? "n/a"}
Rich warm wall: ${richWarm.wallMs ?? "n/a"} ms
Rich warm scanned: ${richWarm.scanned ?? "n/a"}
After-change scanned: ${afterChange.scanned ?? "n/a"}
Post-change warm scanned: ${postChangeWarm.scanned ?? "n/a"}
Rich after-change scanned: ${richAfterChange.scanned ?? "n/a"}
Rich post-change warm scanned: ${richPostChangeWarm.scanned ?? "n/a"}

| Status | Check | Detail |
| --- | --- | --- |
${rows}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const count = numberOption("--count", "EB_SERVER_LISTING_CACHE_COUNT", 8000);
  const imageCount = numberOption("--image-count", "EB_SERVER_LISTING_CACHE_IMAGE_COUNT", 64);
  const herdCount = numberOption("--herd-count", "EB_SERVER_LISTING_CACHE_HERD_COUNT", 8);
  const warmWallBudgetMs = numberOption("--warm-wall-ms", "EB_SERVER_LISTING_CACHE_WARM_WALL_MS", 1200);
  const expectedInitialCount = count + imageCount;
  await prepareFixture(count, imageCount);
  await fs.mkdir(appData, { recursive: true });

  const port = Number(optionValue("--port", process.env.PORT || 52000 + Math.floor(Math.random() * 5000)));
  const baseUrl = `http://127.0.0.1:${port}`;
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

  try {
    await waitForServer(baseUrl, server);
    const route = `/api/list?${new URLSearchParams({
      path: fixtureRoot,
      showHidden: "true",
      includeSignature: "true"
    })}`;
    const richRoute = `/api/list?${new URLSearchParams({
      path: fixtureRoot,
      showHidden: "true",
      includeSignature: "true",
      includeDimensions: "true",
      includeLinks: "true"
    })}`;
    const herdStart = performance.now();
    const herdResponses = await Promise.all(Array.from({ length: herdCount }, () => requestJson(baseUrl, route)));
    const herdWallMs = Math.round((performance.now() - herdStart) * 10) / 10;
    const herdResults = herdResponses.map((result) => summarizeList({ wallMs: herdWallMs, result }));
    const herdOrigins = herdResults.filter((result) => result.cache?.source !== "server-listing-inflight");
    const herdJoined = herdResults.filter((result) => result.cache?.source === "server-listing-inflight");
    const cold = herdOrigins.find((result) => result.cache?.stored === true) || herdOrigins[0] || herdResults[0];
    const warm = summarizeList(await timed(() => requestJson(baseUrl, route)));
    const bypassWindowRoute = `${route}&bypassCache=true&offset=0&limit=200`;
    const bypassWindowResults = (
      await Promise.all(Array.from({ length: 4 }, () => requestJson(baseUrl, bypassWindowRoute)))
    ).map((result) => summarizeList({ wallMs: 0, result }));
    const bypassWindowOrigins = bypassWindowResults.filter((result) => result.cache?.source !== "server-listing-inflight");
    const bypassWindowJoined = bypassWindowResults.filter((result) => result.cache?.source === "server-listing-inflight");
    const richCold = summarizeList(await timed(() => requestJson(baseUrl, richRoute)));
    const richWarm = summarizeList(await timed(() => requestJson(baseUrl, richRoute)));
    const dimensionEntry = richCold.entries.find((entry) => entry.name === "server-cache-image-0000.png");
    const richWarmDimensionEntry = richWarm.entries.find((entry) => entry.name === "server-cache-image-0000.png");
    const watcherVersion = Math.max(
      Number(warm.cache?.watcherVersion ?? cold.cache?.watcherVersion ?? 0),
      Number(richWarm.cache?.watcherVersion ?? richCold.cache?.watcherVersion ?? 0)
    );
    const addedName = "server-cache-added-after-warm.txt";
    const addedPath = path.join(fixtureRoot, addedName);
    await fs.writeFile(addedPath, "created after warm server listing cache\n", "utf8");
    const afterChange = summarizeList(await timed(() => requestJson(baseUrl, route)));
    const watchAfterWrite = await waitForWatcherChange(baseUrl, fixtureRoot, watcherVersion, server);
    const postChangeWarm = summarizeList(await timed(() => requestJson(baseUrl, route)));
    const richAfterChange = summarizeList(await timed(() => requestJson(baseUrl, richRoute)));
    const richPostChangeWarm = summarizeList(await timed(() => requestJson(baseUrl, richRoute)));
    const afterChangeHasAdded = afterChange.entries.some((entry) => entry.path === addedPath);
    const postChangeHasAdded = postChangeWarm.entries.some((entry) => entry.path === addedPath);
    const richAfterChangeHasAdded = richAfterChange.entries.some((entry) => entry.path === addedPath);
    const richPostChangeHasAdded = richPostChangeWarm.entries.some((entry) => entry.path === addedPath);

    check(checks, "server-listing-inflight-single-origin", herdOrigins.length === 1, `origins=${herdOrigins.length}; joined=${herdJoined.length}; requests=${herdCount}.`);
    check(checks, "server-listing-inflight-joined", herdJoined.length >= Math.max(1, herdCount - 1), `joined=${herdJoined.length}; requests=${herdCount}.`);
    check(checks, "server-listing-inflight-scanned-zero", herdJoined.every((result) => Number(result.scanned ?? Infinity) === 0), `joinedScanned=${herdJoined.map((result) => result.scanned).join(",")}.`);
    check(checks, "server-listing-inflight-origin-stored", cold.cache?.stored === true && Number(cold.scanned || 0) >= expectedInitialCount, `stored=${cold.cache?.stored}; scanned=${cold.scanned}.`);
    check(checks, "server-listing-cold-stored", cold.cache?.stored === true, `stored=${cold.cache?.stored}; scanned=${cold.scanned}.`);
    check(checks, "server-listing-warm-hit", warm.cache?.hit === true, `hit=${warm.cache?.hit}; reason=${warm.cache?.reason || "n/a"}.`);
    check(checks, "server-listing-warm-scanned-zero", Number(warm.scanned ?? Infinity) === 0, `scanned=${warm.scanned}.`);
    check(checks, "server-listing-warm-stamp-validated", warm.cache?.stampValidated === true, `stampValidated=${warm.cache?.stampValidated}; stamp=${JSON.stringify(warm.cache?.directoryStamp || null)}.`);
    check(checks, "server-listing-warm-budget", Number(warm.wallMs || 0) <= warmWallBudgetMs, `wall=${warm.wallMs} ms; budget=${warmWallBudgetMs} ms.`);
    check(checks, "server-listing-warm-count", warm.returned === cold.returned && warm.returned >= expectedInitialCount, `cold=${cold.returned}; warm=${warm.returned}; expected=${expectedInitialCount}.`);
    check(
      checks,
      "server-listing-bypass-window-single-origin",
      bypassWindowOrigins.length === 1 && bypassWindowJoined.length === 3,
      `origins=${bypassWindowOrigins.length}; joined=${bypassWindowJoined.length}.`
    );
    check(
      checks,
      "server-listing-bypass-window-bounded",
      bypassWindowResults.every((result) => result.returned === 200),
      `returned=${bypassWindowResults.map((result) => result.returned).join(",")}.`
    );
    check(checks, "server-rich-listing-cold-stored", richCold.cache?.stored === true, `stored=${richCold.cache?.stored}; scanned=${richCold.scanned}; dimensions=${richCold.includeDimensions}.`);
    check(checks, "server-rich-listing-dimensions", dimensionEntry?.dimensions?.width === 1 && richWarmDimensionEntry?.dimensions?.height === 1, `cold=${dimensionEntry?.dimensionText || "missing"}; warm=${richWarmDimensionEntry?.dimensionText || "missing"}.`);
    check(checks, "server-rich-listing-warm-hit", richWarm.cache?.hit === true, `hit=${richWarm.cache?.hit}; dimensions=${richWarm.cache?.includeDimensions}; links=${richWarm.cache?.includeLinks}.`);
    check(checks, "server-rich-listing-warm-scanned-zero", Number(richWarm.scanned ?? Infinity) === 0, `scanned=${richWarm.scanned}.`);
    check(checks, "server-rich-listing-warm-stamp-validated", richWarm.cache?.stampValidated === true, `stampValidated=${richWarm.cache?.stampValidated}; stamp=${JSON.stringify(richWarm.cache?.directoryStamp || null)}.`);
    check(
      checks,
      "server-listing-watch-invalidated",
      watchAfterWrite?.available === true && Number(watchAfterWrite?.version || 0) > Number(watcherVersion || 0),
      `before=${watcherVersion}; after=${watchAfterWrite?.version ?? "missing"}; available=${watchAfterWrite?.available}.`
    );
    check(
      checks,
      "server-listing-after-change-miss",
      afterChange.cache?.hit !== true && Number(afterChange.scanned || 0) >= expectedInitialCount + 1,
      `hit=${afterChange.cache?.hit}; scanned=${afterChange.scanned}.`
    );
    check(
      checks,
      "server-listing-after-change-stale-reason",
      ["directory-stamp-changed", "watcher-version-changed", "miss"].includes(afterChange.cache?.missReason),
      `missReason=${afterChange.cache?.missReason || "missing"}; reason=${afterChange.cache?.reason || "missing"}.`
    );
    check(checks, "server-listing-after-change-row", afterChangeHasAdded, `added=${addedPath}.`);
    check(checks, "server-listing-post-change-warm-hit", postChangeWarm.cache?.hit === true, `hit=${postChangeWarm.cache?.hit}.`);
    check(checks, "server-listing-post-change-scanned-zero", Number(postChangeWarm.scanned ?? Infinity) === 0, `scanned=${postChangeWarm.scanned}.`);
    check(checks, "server-listing-post-change-stamp-validated", postChangeWarm.cache?.stampValidated === true, `stampValidated=${postChangeWarm.cache?.stampValidated}.`);
    check(checks, "server-listing-post-change-row", postChangeHasAdded, `added=${addedPath}.`);
    check(
      checks,
      "server-rich-listing-after-change-miss",
      richAfterChange.cache?.hit !== true && Number(richAfterChange.scanned || 0) >= expectedInitialCount + 1,
      `hit=${richAfterChange.cache?.hit}; scanned=${richAfterChange.scanned}.`
    );
    check(checks, "server-rich-listing-after-change-row", richAfterChangeHasAdded, `added=${addedPath}.`);
    check(checks, "server-rich-listing-post-change-warm-hit", richPostChangeWarm.cache?.hit === true, `hit=${richPostChangeWarm.cache?.hit}; dimensions=${richPostChangeWarm.cache?.includeDimensions}.`);
    check(checks, "server-rich-listing-post-change-scanned-zero", Number(richPostChangeWarm.scanned ?? Infinity) === 0, `scanned=${richPostChangeWarm.scanned}.`);
    check(checks, "server-rich-listing-post-change-stamp-validated", richPostChangeWarm.cache?.stampValidated === true, `stampValidated=${richPostChangeWarm.cache?.stampValidated}.`);
    check(checks, "server-rich-listing-post-change-row", richPostChangeHasAdded, `added=${addedPath}.`);

    const summary = summaryFor(checks);
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      runRoot,
      fixture: { root: fixtureRoot, count, imageCount, totalCount: expectedInitialCount, addedPath },
      budgets: { warmWallBudgetMs, herdCount },
      inFlightHerd: {
        count: herdCount,
        wallMs: herdWallMs,
        origins: herdOrigins.length,
        joined: herdJoined.length,
        joinedScanned: herdJoined.map((result) => result.scanned),
        joinedSources: herdJoined.map((result) => result.cache?.source || ""),
        originScanned: herdOrigins.map((result) => result.scanned),
        originStored: herdOrigins.map((result) => result.cache?.stored === true)
      },
      bypassWindowHerd: {
        count: bypassWindowResults.length,
        origins: bypassWindowOrigins.length,
        joined: bypassWindowJoined.length,
        returned: bypassWindowResults.map((result) => result.returned)
      },
      cold,
      warm,
      richCold: {
        ...richCold,
        dimensionProbe: {
          name: dimensionEntry?.name || null,
          dimensions: dimensionEntry?.dimensions || null,
          dimensionText: dimensionEntry?.dimensionText || ""
        }
      },
      richWarm: {
        ...richWarm,
        dimensionProbe: {
          name: richWarmDimensionEntry?.name || null,
          dimensions: richWarmDimensionEntry?.dimensions || null,
          dimensionText: richWarmDimensionEntry?.dimensionText || ""
        }
      },
      watchAfterWrite,
      afterChange,
      postChangeWarm,
      richAfterChange,
      richPostChangeWarm,
      checks,
      summary
    };
    delete report.cold.entries;
    delete report.warm.entries;
    delete report.richCold.entries;
    delete report.richWarm.entries;
    delete report.afterChange.entries;
    delete report.postChangeWarm.entries;
    delete report.richAfterChange.entries;
    delete report.richPostChangeWarm.entries;
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`server listing cache: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    console.log(`in-flight joined ${herdJoined.length}/${herdCount} request(s), wall ${herdWallMs} ms`);
    console.log(`warm scanned ${warm.scanned}, wall ${warm.wallMs} ms for ${expectedInitialCount} entries`);
    console.log(`rich warm scanned ${richWarm.scanned}, wall ${richWarm.wallMs} ms with ${imageCount} image entries`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (summary.fail > 0) {
      process.exitCode = 1;
    }
  } finally {
    await stopServer(server);
    if (!keepFixture()) {
      await safeRemoveRunRoot().catch(() => {});
    }
  }
}

main().catch(async (error) => {
  const checks = [{ id: "server-listing-cache-error", status: "fail", detail: error.stack || error.message }];
  const summary = summaryFor(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    status: "fail",
    runRoot,
    fixture: { root: fixtureRoot },
    serverOutput: serverOutput.slice(-4000),
    checks,
    summary
  };
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8").catch(() => {});
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8").catch(() => {});
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
