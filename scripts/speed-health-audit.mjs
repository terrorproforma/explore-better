import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const latestJsonPath = path.join(artifactsDir, "speed-health-latest.json");
const latestMdPath = path.join(artifactsDir, "speed-health-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

const maxAgeHours = Math.max(
  1,
  Math.min(Number(optionValue("--max-age-hours", process.env.EB_SPEED_HEALTH_MAX_AGE_HOURS || 72)), 24 * 14)
);
const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
const allowTrendRegressionWarning =
  process.argv.includes("--allow-trend-regression-warning") ||
  process.env.EB_SPEED_HEALTH_ALLOW_TREND_REGRESSION_WARNING === "1" ||
  process.env.EB_SPEED_HEALTH_FAIL_ON_TREND_REGRESSION === "0";
const failOnTrendRegression = !allowTrendRegressionWarning;

function rounded(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null;
}

function statusRank(status) {
  return status === "fail" ? 3 : status === "warn" ? 2 : 1;
}

function worstStatus(items) {
  return items.reduce((worst, item) => (statusRank(item.status) > statusRank(worst) ? item.status : worst), "pass");
}

function formatAge(ms) {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 1) return `${Math.max(0, Math.round(hours * 60))}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function short(value, max = 280) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

async function readJsonArtifact(name, checks) {
  const filePath = path.join(artifactsDir, name);
  let stat = null;
  try {
    stat = await fs.stat(filePath);
  } catch {
    checks.push({
      area: "evidence",
      id: `artifact:${name}`,
      status: "fail",
      detail: `Missing ${name}.`,
      path: filePath
    });
    return null;
  }

  let data = null;
  try {
    data = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    checks.push({
      area: "evidence",
      id: `artifact:${name}`,
      status: "fail",
      detail: `${name} is not readable JSON: ${error.message}`,
      path: filePath
    });
    return null;
  }

  const generatedAt = data.generatedAt || null;
  const generatedMs = Date.parse(generatedAt || "");
  const ageMs = Number.isFinite(generatedMs) ? Date.now() - generatedMs : Date.now() - Number(stat.mtimeMs || 0);
  const stale = ageMs > maxAgeMs;
  checks.push({
    area: "evidence",
    id: `artifact:${name}`,
    status: stale ? "fail" : "pass",
    detail: `${name} ${stale ? "stale" : "fresh"} (${formatAge(ageMs)} old).`,
    path: filePath,
    generatedAt,
    ageMs
  });
  return { data, path: filePath, generatedAt, ageMs };
}

function addStatusCheck(checks, area, id, ok, detail, extra = {}) {
  checks.push({
    area,
    id,
    status: ok ? "pass" : "fail",
    detail,
    ...extra
  });
}

function addWarnCheck(checks, area, id, status, detail, extra = {}) {
  checks.push({ area, id, status, detail, ...extra });
}

function addMetric(metrics, checks, area, name, actual, budget, source, detail = "", options = {}) {
  const numeric = Number(actual);
  const numericBudget = Number(budget);
  const ok = Number.isFinite(numeric) && Number.isFinite(numericBudget) && numeric <= numericBudget;
  const percentOfBudget = ok ? rounded((numeric / numericBudget) * 100) : null;
  const headroomMs = ok ? rounded(numericBudget - numeric) : null;
  const status = ok ? "pass" : "fail";
  const metric = {
    area,
    name,
    status,
    actual: rounded(numeric),
    budget: rounded(numericBudget),
    unit: options.unit || "ms",
    percentOfBudget,
    headroomMs,
    source,
    detail: short(detail)
  };
  metrics.push(metric);
  checks.push({
    area,
    id: `metric:${name}`,
    status,
    detail: ok
      ? `${name}: ${metric.actual}${metric.unit} <= ${metric.budget}${metric.unit} (${percentOfBudget}% of budget).`
      : `${name}: ${Number.isFinite(numeric) ? rounded(numeric) : "missing"}${metric.unit} exceeds ${metric.budget}${metric.unit}.`,
    source
  });
  return metric;
}

function addMinimum(checks, area, id, actual, minimum, detail = "") {
  const numeric = Number(actual);
  const ok = Number.isFinite(numeric) && numeric >= minimum;
  checks.push({
    area,
    id,
    status: ok ? "pass" : "fail",
    actual: rounded(numeric),
    budget: `>= ${minimum}`,
    detail: ok ? `${detail || id}: ${rounded(numeric)} >= ${minimum}.` : `${detail || id}: ${actual ?? "missing"} < ${minimum}.`
  });
}

function sourceChecksPass(data) {
  return Array.isArray(data?.checks) && data.checks.length > 0 && data.checks.every((check) => check.status === "pass");
}

function numericBudgetChecks(checks = []) {
  return checks.filter((check) => Number.isFinite(Number(check.actual)) && Number.isFinite(Number(check.budget)));
}

function metricByName(checks = [], name) {
  return checks.find((check) => check.name === name);
}

function parseMsText(text) {
  const match = String(text || "").match(/([0-9]+(?:\.[0-9]+)?)\s*ms/i);
  return match ? Number(match[1]) : null;
}

function countFailedChecks(data) {
  return Array.isArray(data?.checks) ? data.checks.filter((check) => check.status === "fail").length : 0;
}

function countPageErrors(report) {
  return (Array.isArray(report?.pageErrors) ? report.pageErrors.length : 0) +
    (Array.isArray(report?.consoleErrors) ? report.consoleErrors.length : 0);
}

function areaSummaries(checks) {
  const areas = new Map();
  for (const check of checks) {
    if (!areas.has(check.area)) areas.set(check.area, []);
    areas.get(check.area).push(check);
  }
  return [...areas].map(([area, items]) => ({
    area,
    status: worstStatus(items),
    pass: items.filter((item) => item.status === "pass").length,
    warn: items.filter((item) => item.status === "warn").length,
    fail: items.filter((item) => item.status === "fail").length
  }));
}

function hottestMetrics(metrics, limit = 10) {
  return metrics
    .filter((metric) => metric.status === "pass" && Number.isFinite(metric.percentOfBudget))
    .sort((left, right) => right.percentOfBudget - left.percentOfBudget)
    .slice(0, limit);
}

function markdownReport(report) {
  const summaryRows = report.areas
    .map((area) => `| ${area.status.toUpperCase()} | ${area.area} | ${area.pass} | ${area.warn} | ${area.fail} |`)
    .join("\n");
  const checkRows = report.checks
    .filter((check) => check.status !== "pass")
    .map((check) => `| ${check.status.toUpperCase()} | ${check.area} | ${check.id} | ${short(check.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  const metricRows = hottestMetrics(report.metrics, 14)
    .map(
      (metric) =>
        `| ${metric.area} | ${metric.name} | ${metric.actual}${metric.unit} | ${metric.budget}${metric.unit} | ${metric.percentOfBudget}% |`
    )
    .join("\n");
  const snapshotRows = report.snapshots
    .map((snapshot) => `| ${snapshot.name} | ${snapshot.value} | ${snapshot.detail.replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Explore Better Speed Health

Generated: ${report.generatedAt}
Status: ${report.status.toUpperCase()}
Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

## Areas

| Status | Area | Pass | Warn | Fail |
| --- | --- | ---: | ---: | ---: |
${summaryRows}

## Hot Metrics

| Area | Metric | Actual | Budget | Used |
| --- | --- | ---: | ---: | ---: |
${metricRows}

## Snapshots

| Snapshot | Value | Detail |
| --- | ---: | --- |
${snapshotRows}

## Warnings and Failures

| Status | Area | Check | Detail |
| --- | --- | --- | --- |
${checkRows || "| PASS | all | none | No warnings or failures. |"}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const metrics = [];
  const snapshots = [];
  const artifacts = {};

  for (const name of [
    "perf-guard-latest.json",
    "perf-trend-latest.json",
    "startup-latency-latest.json",
    "perf-100k-latest.json",
    "windows-baseline-latest.json",
    "server-listing-cache-latest.json",
    "folder-index-token-search-latest.json",
    "mixed-load-latest.json",
    "listing-cache-ui-latest.json",
    "listing-cache-eviction-ui-latest.json",
    "listing-prefetch-ui-latest.json",
    "rapid-navigation-ui-latest.json",
    "operation-preview-scale-latest.json",
    "operation-listing-cache-latest.json",
    "thumbnail-cache-ui-latest.json",
    "large-folder-ui-latest.json",
    "large-folder-100k-ui-latest.json",
    "size-analysis-perf-latest.json",
    "size-analysis-cancel-latest.json",
    "network-loopback-latest.json",
    "background-index-latest.json",
    "background-index-freshness-latest.json",
    "background-index-watch-latest.json",
    "background-index-operation-latest.json",
    "scripting-mutation-cache-latest.json",
    "background-index-restart-latest.json",
    "background-index-isolation-latest.json",
    "background-index-concurrency-latest.json",
    "background-index-token-search-latest.json",
    "speed-index-ui-latest.json",
    "search-background-ui-latest.json"
  ]) {
    artifacts[name] = await readJsonArtifact(name, checks);
  }

  const perfGuard = artifacts["perf-guard-latest.json"]?.data;
  addStatusCheck(
    checks,
    "guard",
    "perf-guard-pass",
    perfGuard?.status === "pass" && countFailedChecks(perfGuard) === 0,
    `Perf guard status=${perfGuard?.status || "missing"}; failures=${countFailedChecks(perfGuard)}.`
  );
  for (const sourceCheck of numericBudgetChecks(perfGuard?.checks || [])) {
    addMetric(metrics, checks, "guard", sourceCheck.name, sourceCheck.actual, sourceCheck.budget, "perf-guard-latest.json", sourceCheck.detail);
  }

  const perfTrend = artifacts["perf-trend-latest.json"]?.data;
  const regressions = Array.isArray(perfTrend?.regressions) ? perfTrend.regressions : [];
  addWarnCheck(
    checks,
    "trend",
    "trend-regressions",
    regressions.length ? (failOnTrendRegression ? "fail" : "warn") : "pass",
    regressions.length
      ? `${regressions.length} trend regression(s): ${regressions.map((item) => item.name).join(", ")}.`
      : `${perfTrend?.comparisons?.length || 0} trend comparison(s), no regressions.`
  );
  const improvements = Array.isArray(perfTrend?.improvements) ? perfTrend.improvements : [];
  snapshots.push({
    name: "Trend comparisons",
    value: String(perfTrend?.comparisons?.length || 0),
    detail: `${improvements.length} improvement(s), ${regressions.length} regression(s), history=${perfTrend?.historyEntries || 0}.`
  });

  const startup = artifacts["startup-latency-latest.json"]?.data;
  addStatusCheck(
    checks,
    "startup",
    "startup-source-clean",
    startup?.status === "pass" && sourceChecksPass(startup),
    `Startup status=${startup?.status || "missing"}; source failures=${countFailedChecks(startup)}.`
  );
  addMetric(metrics, checks, "startup", "Server roots ready", startup?.server?.roots?.sinceStartMs, startup?.budgets?.rootsReadyMs, "startup-latency-latest.json");
  addMetric(metrics, checks, "startup", "First folder list", startup?.firstList?.wallMs, startup?.budgets?.firstListWallMs, "startup-latency-latest.json");
  addMetric(metrics, checks, "startup", "Browser DOMContentLoaded", startup?.browser?.domContentLoadedWallMs, startup?.budgets?.pageDomWallMs, "startup-latency-latest.json");
  addMetric(metrics, checks, "startup", "First visible rows", startup?.browser?.firstRowsWallMs, startup?.budgets?.firstRowsWallMs, "startup-latency-latest.json");
  addMinimum(checks, "startup", "startup-rendered-rows", startup?.browser?.snapshot?.renderedRows, 1, "Startup visible rows");

  const perf100k = artifacts["perf-100k-latest.json"]?.data;
  addStatusCheck(
    checks,
    "stress-100k",
    "100k-source-clean",
    perf100k?.status === "pass" && sourceChecksPass(perf100k) && Number(perf100k?.count || 0) >= 100000,
    `100k status=${perf100k?.status || "missing"}; count=${perf100k?.count || 0}; source failures=${countFailedChecks(perf100k)}.`
  );
  for (const sourceCheck of numericBudgetChecks(perf100k?.checks || [])) {
    addMetric(metrics, checks, "stress-100k", sourceCheck.name, sourceCheck.actual, sourceCheck.budget, "perf-100k-latest.json", sourceCheck.detail);
  }
  const indexSearch100k = metricByName(perf100k?.checks || [], "100k folder index search");
  const indexSearchScanned100k = metricByName(perf100k?.checks || [], "100k folder index search scanned");
  const backgroundSearch100k = metricByName(perf100k?.checks || [], "100k background index search");
  snapshots.push({
    name: "100k folder",
    value: `${perf100k?.run?.cold?.wallMs || "?"}ms cold`,
    detail: `warm=${perf100k?.run?.warm?.wallMs || "?"}ms, warmScanned=${perf100k?.run?.warm?.result?.scanned ?? "?"}, warmCache=${perf100k?.run?.warm?.result?.cache?.hit === true}, indexSearch=${indexSearch100k?.actual || "?"}ms, indexScanned=${indexSearchScanned100k?.actual || "?"}, backgroundSearch=${backgroundSearch100k?.actual || "?"}ms.`
  });

  const windowsBaseline = artifacts["windows-baseline-latest.json"]?.data;
  const baselineCases = Array.isArray(windowsBaseline?.cases) ? windowsBaseline.cases : [];
  const largestBaseline = baselineCases.reduce(
    (largest, item) => (Number(item.count || 0) > Number(largest?.count || 0) ? item : largest),
    null
  );
  addStatusCheck(
    checks,
    "native-baseline",
    "windows-baseline-clean",
    windowsBaseline?.status === "pass" &&
      countFailedChecks(windowsBaseline) === 0 &&
      baselineCases.some((item) => Number(item.count || 0) >= 100000) &&
      baselineCases.every(
        (item) =>
          Number(item.native?.second?.scanned || 0) >= Number(item.count || 0) &&
          item.app?.warm?.cache?.hit === true &&
          Number(item.app?.warm?.scanned ?? Infinity) === 0 &&
          item.app?.warmWindow?.cache?.hit === true &&
          Number(item.app?.warmWindow?.scanned ?? Infinity) === 0 &&
          Number(item.app?.warmWindow?.returned || 0) ===
            Math.min(
              Number(item.budgets?.windowLimit || windowsBaseline?.budgets?.windowLimit || 200),
              Number(item.count || 0)
            ) &&
          Number(item.app?.warmWindow?.totalEntries || 0) === Number(item.count || 0) &&
          Number(item.app?.indexSearch?.returned || 0) === 1 &&
          Number(item.app?.indexSearch?.scanned ?? Infinity) <=
            Number(item.budgets?.searchScannedBudget || windowsBaseline?.budgets?.searchScannedBudget || 2)
      ),
    `windowsBaseline status=${windowsBaseline?.status || "missing"}; largest=${largestBaseline?.count || 0}; nativeScanned=${largestBaseline?.native?.second?.scanned ?? "missing"}; warmScanned=${largestBaseline?.app?.warm?.scanned ?? "missing"}; windowScanned=${largestBaseline?.app?.warmWindow?.scanned ?? "missing"}; indexSearchScanned=${largestBaseline?.app?.indexSearch?.scanned ?? "missing"}.`
  );
  for (const item of baselineCases) {
    addMetric(
      metrics,
      checks,
      "native-baseline",
      `${item.count} warm app list after native baseline`,
      item.app?.warm?.wallMs,
      item.budgets?.warmWallBudgetMs || windowsBaseline?.budgets?.warmWallBudgetMs || 1500,
      "windows-baseline-latest.json"
    );
    addMetric(
      metrics,
      checks,
      "native-baseline",
      `${item.count} windowed warm app list after native baseline`,
      item.app?.warmWindow?.wallMs,
      item.budgets?.windowWallBudgetMs || windowsBaseline?.budgets?.windowWallBudgetMs || 250,
      "windows-baseline-latest.json",
      `Returned ${item.app?.warmWindow?.returned ?? "?"}/${item.app?.warmWindow?.totalEntries ?? "?"} entries from a warm cache.`
    );
    addMetric(
      metrics,
      checks,
      "native-baseline",
      `${item.count} active index build after native baseline`,
      item.app?.indexBuild?.wallMs,
      item.budgets?.buildWallBudgetMs || windowsBaseline?.budgets?.buildWallBudgetMs || 8000,
      "windows-baseline-latest.json"
    );
    addMetric(
      metrics,
      checks,
      "native-baseline",
      `${item.count} indexed search after native baseline`,
      item.app?.indexSearch?.wallMs,
      item.budgets?.searchWallBudgetMs || windowsBaseline?.budgets?.searchWallBudgetMs || 750,
      "windows-baseline-latest.json"
    );
    addMetric(
      metrics,
      checks,
      "native-baseline",
      `${item.count} indexed search candidates after native baseline`,
      item.app?.indexSearch?.scanned,
      item.budgets?.searchScannedBudget || windowsBaseline?.budgets?.searchScannedBudget || 2,
      "windows-baseline-latest.json",
      `Native enumeration scanned ${item.native?.second?.scanned ?? "?"} item(s).`,
      { unit: " rows" }
    );
  }
  snapshots.push({
    name: "Windows native baseline",
    value: largestBaseline ? `${largestBaseline.count} entries` : "missing",
    detail: largestBaseline
      ? `native warm scanned ${largestBaseline.native?.second?.scanned ?? "?"}; app warm scanned ${largestBaseline.app?.warm?.scanned ?? "?"}; window ${largestBaseline.app?.warmWindow?.returned ?? "?"}/${largestBaseline.app?.warmWindow?.totalEntries ?? "?"} in ${largestBaseline.app?.warmWindow?.wallMs ?? "?"}ms; indexed search scanned ${largestBaseline.app?.indexSearch?.scanned ?? "?"}.`
      : "No baseline artifact available."
  });

  const serverListing = artifacts["server-listing-cache-latest.json"]?.data;
  addStatusCheck(
    checks,
    "stress-100k",
    "server-listing-cache",
    serverListing?.status === "pass" &&
      countFailedChecks(serverListing) === 0 &&
      serverListing?.warm?.cache?.hit === true &&
      serverListing?.warm?.cache?.stampValidated === true &&
      Number(serverListing?.warm?.scanned ?? Infinity) === 0 &&
      serverListing?.afterChange?.cache?.hit !== true &&
      serverListing?.postChangeWarm?.cache?.hit === true &&
      serverListing?.postChangeWarm?.cache?.stampValidated === true &&
      Number(serverListing?.postChangeWarm?.scanned ?? Infinity) === 0 &&
      serverListing?.richWarm?.cache?.hit === true &&
      serverListing?.richWarm?.cache?.stampValidated === true &&
      Number(serverListing?.richWarm?.scanned ?? Infinity) === 0 &&
      serverListing?.richAfterChange?.cache?.hit !== true &&
      serverListing?.richPostChangeWarm?.cache?.hit === true &&
      serverListing?.richPostChangeWarm?.cache?.stampValidated === true &&
      Number(serverListing?.richPostChangeWarm?.scanned ?? Infinity) === 0 &&
      Number(serverListing?.inFlightHerd?.origins || 0) === 1 &&
      Number(serverListing?.inFlightHerd?.joined || 0) >= Math.max(1, Number(serverListing?.inFlightHerd?.count || 0) - 1) &&
      (serverListing?.inFlightHerd?.joinedScanned || []).every((value) => Number(value || 0) === 0),
    `serverListing status=${serverListing?.status || "missing"}; warmHit=${serverListing?.warm?.cache?.hit}; warmScanned=${serverListing?.warm?.scanned ?? "missing"}; richWarmHit=${serverListing?.richWarm?.cache?.hit}; richWarmScanned=${serverListing?.richWarm?.scanned ?? "missing"}; herdJoined=${serverListing?.inFlightHerd?.joined ?? "missing"}/${serverListing?.inFlightHerd?.count ?? "missing"}.`
  );
  addMinimum(
    checks,
    "stress-100k",
    "server-listing-inflight-coalescing",
    serverListing?.inFlightHerd?.joined,
    Math.max(1, Number(serverListing?.inFlightHerd?.count || 0) - 1),
    "Cold duplicate folder requests should join the same in-flight server listing instead of launching duplicate scans."
  );
  addMetric(
    metrics,
    checks,
    "stress-100k",
    "Server listing warm wall",
    serverListing?.warm?.wallMs,
    serverListing?.budgets?.warmWallBudgetMs || 1200,
    "server-listing-cache-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "stress-100k",
    "Rich server listing warm wall",
    serverListing?.richWarm?.wallMs,
    serverListing?.budgets?.warmWallBudgetMs || 1200,
    "server-listing-cache-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "stress-100k",
    "Rich server listing warm scanned",
    serverListing?.richWarm?.scanned,
    1,
    "server-listing-cache-latest.json",
    "Warm thumbnail/link metadata folders should return from server cache without stat scanning.",
    { unit: " rows" }
  );
  addMetric(
    metrics,
    checks,
    "stress-100k",
    "Server listing warm scanned",
    serverListing?.warm?.scanned,
    1,
    "server-listing-cache-latest.json",
    "Warm unchanged folders should return from server cache without stat scanning.",
    { unit: " rows" }
  );
  addMinimum(
    checks,
    "stress-100k",
    "server-listing-cache-hit",
    serverListing?.warm?.cache?.hit === true ? 1 : 0,
    1,
    "Server listing warm cache hit"
  );
  snapshots.push({
    name: "Server listing cache",
    value: `${serverListing?.warm?.scanned ?? "?"} scanned`,
    detail: `${serverListing?.fixture?.totalCount || serverListing?.fixture?.count || 0} file fixture, herdJoined=${serverListing?.inFlightHerd?.joined ?? "?"}/${serverListing?.inFlightHerd?.count ?? "?"}, warm=${serverListing?.warm?.wallMs ?? "?"}ms, richWarm=${serverListing?.richWarm?.wallMs ?? "?"}ms, afterChangeScanned=${serverListing?.afterChange?.scanned ?? "?"}, richAfterChangeScanned=${serverListing?.richAfterChange?.scanned ?? "?"}.`
  });

  const folderToken = artifacts["folder-index-token-search-latest.json"]?.data;
  addStatusCheck(
    checks,
    "stress-100k",
    "folder-index-token-search",
    folderToken?.status === "pass" &&
      countFailedChecks(folderToken) === 0 &&
      folderToken?.search?.hit === true &&
      folderToken?.repeatSearch?.hit === true &&
      folderToken?.search?.timing?.tokenNarrowed === true &&
      Number(folderToken?.search?.timing?.scanned || Infinity) <= Number(folderToken?.budgets?.scannedBudget || 5) &&
      Number(folderToken?.repeatSearch?.timing?.storeCacheHits || 0) >= 1,
    `folderToken status=${folderToken?.status || "missing"}; scanned=${folderToken?.search?.timing?.scanned ?? "missing"}; repeatCacheHits=${folderToken?.repeatSearch?.timing?.storeCacheHits ?? "missing"}.`
  );
  addMetric(
    metrics,
    checks,
    "stress-100k",
    "Folder token search scanned",
    folderToken?.search?.timing?.scanned,
    folderToken?.budgets?.scannedBudget || 5,
    "folder-index-token-search-latest.json",
    "Exact active-folder index search should avoid scanning the full folder index.",
    { unit: " rows" }
  );
  addMetric(
    metrics,
    checks,
    "stress-100k",
    "Folder token repeat wall",
    folderToken?.repeatSearch?.wallMs,
    folderToken?.budgets?.repeatWallBudgetMs || 250,
    "folder-index-token-search-latest.json"
  );
  addMinimum(
    checks,
    "stress-100k",
    "folder-token-repeat-cache-hit",
    folderToken?.repeatSearch?.timing?.storeCacheHits,
    1,
    "Active folder token search repeat cache hits"
  );
  snapshots.push({
    name: "Active index token search",
    value: `${folderToken?.search?.timing?.scanned ?? "?"} scanned`,
    detail: `${folderToken?.fixture?.count || 0} file active index, first=${folderToken?.search?.wallMs ?? "?"}ms, repeat=${folderToken?.repeatSearch?.wallMs ?? "?"}ms, repeatCacheHits=${folderToken?.repeatSearch?.timing?.storeCacheHits ?? "?"}.`
  });

  const listing = artifacts["listing-cache-ui-latest.json"]?.data;
  addStatusCheck(
    checks,
    "browser-cache",
    "listing-cache-ui-clean",
    listing?.status === "pass" && countFailedChecks(listing) === 0 && listing?.cold?.source === "Filesystem" && listing?.warm?.source === "Memory cache",
    `Listing cache cold=${listing?.cold?.source || "missing"}; warm=${listing?.warm?.source || "missing"}; failures=${countFailedChecks(listing)}.`
  );
  addMetric(metrics, checks, "browser-cache", "Warm revisit live load", listing?.warm?.liveLoadMs, 250, "listing-cache-ui-latest.json");
  snapshots.push({
    name: "Listing cache",
    value: listing?.warm?.source || "missing",
    detail: `warm live=${listing?.warm?.liveLoadMs ?? "?"}ms, status=${listing?.warm?.statusText || "missing"}.`
  });

  const listingEviction = artifacts["listing-cache-eviction-ui-latest.json"]?.data;
  addStatusCheck(
    checks,
    "browser-cache",
    "listing-cache-eviction-clean",
    listingEviction?.status === "pass" &&
      countFailedChecks(listingEviction) === 0 &&
      listingEviction?.snapshots?.oldAfterChurn?.source === "Filesystem" &&
      listingEviction?.snapshots?.recentAfterChurn?.source === "Memory cache" &&
      Number(listingEviction?.requests?.oldRequestDelta || 0) >= 1 &&
      Number(listingEviction?.requests?.recentRequestDelta || 0) === 0,
    `Cache eviction status=${listingEviction?.status || "missing"}; old=${listingEviction?.snapshots?.oldAfterChurn?.source || "missing"}; recent=${listingEviction?.snapshots?.recentAfterChurn?.source || "missing"}.`
  );
  addMetric(
    metrics,
    checks,
    "browser-cache",
    "Listing cache churn",
    listingEviction?.churn?.elapsedMs,
    listingEviction?.cache?.ttlMs || 8000,
    "listing-cache-eviction-ui-latest.json"
  );
  snapshots.push({
    name: "Listing cache eviction",
    value: listingEviction?.snapshots?.oldAfterChurn?.source || "missing",
    detail: `old=${listingEviction?.snapshots?.oldAfterChurn?.source || "missing"}, recent=${listingEviction?.snapshots?.recentAfterChurn?.source || "missing"}, churn=${listingEviction?.churn?.elapsedMs ?? "?"}ms.`
  });

  const listingPrefetch = artifacts["listing-prefetch-ui-latest.json"]?.data;
  addStatusCheck(
    checks,
    "browser-cache",
    "listing-prefetch-clean",
    listingPrefetch?.status === "pass" &&
      countFailedChecks(listingPrefetch) === 0 &&
      Number(listingPrefetch?.prefetch?.startedWhileHeld || 0) <= Number(listingPrefetch?.prefetch?.maxActive || 2) &&
      listingPrefetch?.snapshots?.afterOpen?.source === "Memory cache" &&
      Number(listingPrefetch?.prefetch?.targetOpenRequestDelta || 0) === 0,
    `Prefetch status=${listingPrefetch?.status || "missing"}; started=${listingPrefetch?.prefetch?.startedWhileHeld ?? "missing"}; afterOpen=${listingPrefetch?.snapshots?.afterOpen?.source || "missing"}.`
  );
  addMetric(
    metrics,
    checks,
    "browser-cache",
    "Prefetch active requests",
    listingPrefetch?.prefetch?.startedWhileHeld,
    listingPrefetch?.prefetch?.maxActive || 2,
    "listing-prefetch-ui-latest.json",
    "Held hover prefetch requests should not exceed the active-request budget.",
    { unit: " requests" }
  );
  snapshots.push({
    name: "Listing prefetch",
    value: listingPrefetch?.snapshots?.afterOpen?.source || "missing",
    detail: `started=${listingPrefetch?.prefetch?.startedWhileHeld ?? "?"}/${listingPrefetch?.prefetch?.maxActive ?? "?"}, openDelta=${listingPrefetch?.prefetch?.targetOpenRequestDelta ?? "?"}.`
  });

  const rapid = artifacts["rapid-navigation-ui-latest.json"]?.data;
  addStatusCheck(
    checks,
    "browser-cache",
    "rapid-navigation-clean",
    rapid?.status === "pass" &&
      countFailedChecks(rapid) === 0 &&
      rapid?.navigation?.afterSlowResponse?.finalVisible === true &&
      rapid?.navigation?.afterSlowResponse?.staleVisible === false,
    `Rapid nav status=${rapid?.status || "missing"}; delayed=${rapid?.routeStats?.delayedSlowRequests || 0}.`
  );

  const mixedLoad = artifacts["mixed-load-latest.json"]?.data;
  addStatusCheck(
    checks,
    "mixed-load",
    "mixed-load-clean",
    mixedLoad?.status === "pass" &&
      countFailedChecks(mixedLoad) === 0 &&
      Number(mixedLoad?.workload?.operationCount || 0) >= 32 &&
      Number(mixedLoad?.operations?.list?.minReturned || 0) >= Number(mixedLoad?.fixture?.fileCount || 1) &&
      Number(mixedLoad?.operations?.raw?.minBytes || 0) > 0,
    `status=${mixedLoad?.status || "missing"}; ops=${mixedLoad?.workload?.operationCount || 0}; failures=${countFailedChecks(mixedLoad)}.`
  );
  addMetric(
    metrics,
    checks,
    "mixed-load",
    "Mixed load list p95",
    mixedLoad?.operations?.list?.p95Ms,
    mixedLoad?.budgets?.listP95Ms || 1500,
    "mixed-load-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "mixed-load",
    "Mixed load name search p95",
    mixedLoad?.operations?.nameSearch?.p95Ms,
    mixedLoad?.budgets?.nameSearchP95Ms || 1500,
    "mixed-load-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "mixed-load",
    "Mixed load content search p95",
    mixedLoad?.operations?.contentSearch?.p95Ms,
    mixedLoad?.budgets?.contentSearchP95Ms || 4500,
    "mixed-load-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "mixed-load",
    "Mixed load raw p95",
    mixedLoad?.operations?.raw?.p95Ms,
    mixedLoad?.budgets?.rawP95Ms || 1000,
    "mixed-load-latest.json"
  );
  snapshots.push({
    name: "Mixed load",
    value: `${mixedLoad?.workload?.operationCount || 0} ops`,
    detail: `list p95=${mixedLoad?.operations?.list?.p95Ms ?? "?"}ms, search p95=${mixedLoad?.operations?.nameSearch?.p95Ms ?? "?"}ms, raw p95=${mixedLoad?.operations?.raw?.p95Ms ?? "?"}ms.`
  });

  const operationPreviewScale = artifacts["operation-preview-scale-latest.json"]?.data;
  addStatusCheck(
    checks,
    "operations",
    "operation-preview-scale-clean",
    operationPreviewScale?.status === "pass" &&
      countFailedChecks(operationPreviewScale) === 0 &&
      Number(operationPreviewScale?.transfer?.count || 0) >= 500 &&
      Number(operationPreviewScale?.sync?.count || 0) >= 1000 &&
      operationPreviewScale?.transfer?.nonMutating === true &&
      operationPreviewScale?.sync?.nonMutating === true,
    `previewScale status=${operationPreviewScale?.status || "missing"}; transfer=${operationPreviewScale?.transfer?.count || 0}; sync=${operationPreviewScale?.sync?.count || 0}.`
  );
  addMetric(
    metrics,
    checks,
    "operations",
    "500 item transfer conflict preview",
    operationPreviewScale?.transfer?.wallMs,
    operationPreviewScale?.budgets?.transferBudgetMs || 6000,
    "operation-preview-scale-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "operations",
    "1000 item sync conflict preview",
    operationPreviewScale?.sync?.wallMs,
    operationPreviewScale?.budgets?.syncBudgetMs || 7000,
    "operation-preview-scale-latest.json"
  );
  snapshots.push({
    name: "Operation preview scale",
    value: `${operationPreviewScale?.transfer?.count || 0}/${operationPreviewScale?.sync?.count || 0}`,
    detail: `transfer=${operationPreviewScale?.transfer?.wallMs ?? "?"}ms, sync=${operationPreviewScale?.sync?.wallMs ?? "?"}ms, nonMutating=${operationPreviewScale?.transfer?.nonMutating === true && operationPreviewScale?.sync?.nonMutating === true}.`
  });

  const operationListingCache = artifacts["operation-listing-cache-latest.json"]?.data;
  const operationInvalidationTypes = ["create", "copy", "move", "rename", "delete", "sync"];
  const operationInvalidationCount = operationInvalidationTypes.filter(
    (type) => Number(operationListingCache?.operations?.[type]?.invalidated || 0) >= 1
  ).length;
  addStatusCheck(
    checks,
    "operations",
    "operation-listing-cache-invalidation",
    operationListingCache?.status === "pass" &&
      countFailedChecks(operationListingCache) === 0 &&
      operationInvalidationCount === operationInvalidationTypes.length,
    `operation cache status=${operationListingCache?.status || "missing"}; activeInvalidations=${operationInvalidationCount}/${operationInvalidationTypes.length}.`
  );
  addMinimum(
    checks,
    "operations",
    "operation-listing-cache-types",
    operationInvalidationCount,
    operationInvalidationTypes.length,
    "Operation types with active listing-cache invalidation"
  );
  snapshots.push({
    name: "Operation cache invalidation",
    value: `${operationInvalidationCount}/${operationInvalidationTypes.length}`,
    detail: `create/copy/move/rename/delete/sync warmed-cache invalidation status=${operationListingCache?.status || "missing"}.`
  });

  const thumbnail = artifacts["thumbnail-cache-ui-latest.json"]?.data;
  const thumbnailInitial = Number(thumbnail?.tiles?.initialRaw?.uniquePaths || 0);
  const thumbnailAfter = Number(thumbnail?.tiles?.afterScrollRaw?.uniquePaths || 0);
  const thumbnailCount = Number(thumbnail?.count || 0);
  const thumbnailRangeOk =
    thumbnail?.cache?.rangeRaw?.status === 206 &&
    Number(thumbnail?.cache?.rangeRaw?.bytes || 0) > 0 &&
    /^bytes 0-/.test(thumbnail?.cache?.rangeRaw?.contentRange || "");
  const thumbnailHerdOk =
    Number(thumbnail?.cache?.conditionalHerd?.count || 0) > 0 &&
    Number(thumbnail?.cache?.conditionalHerd?.notModified || 0) === Number(thumbnail?.cache?.conditionalHerd?.count || 0);
  addStatusCheck(
    checks,
    "thumbnail-cache",
    "thumbnail-source-clean",
    thumbnail?.status === "pass" &&
      countFailedChecks(thumbnail) === 0 &&
      thumbnail?.cache?.conditionalRaw?.status === 304 &&
      thumbnailRangeOk &&
      thumbnailHerdOk &&
      thumbnail?.tiles?.initial?.virtualized === true &&
      thumbnailInitial > 0 &&
      thumbnailInitial < thumbnailCount * 0.35 &&
      thumbnailAfter > thumbnailInitial &&
      thumbnailAfter < thumbnailCount,
    `thumbnail initial=${thumbnailInitial}/${thumbnailCount}; afterScroll=${thumbnailAfter}; conditional=${thumbnail?.cache?.conditionalRaw?.status || "missing"}; range=${thumbnail?.cache?.rangeRaw?.status || "missing"}; herd=${thumbnail?.cache?.conditionalHerd?.notModified || 0}/${thumbnail?.cache?.conditionalHerd?.count || 0}.`
  );
  addMinimum(checks, "thumbnail-cache", "thumbnail-initial-loaded", thumbnail?.tiles?.initial?.loadedImages, 1, "Initial thumbnails loaded");
  snapshots.push({
    name: "Thumbnail lazy load",
    value: `${thumbnailInitial}/${thumbnailCount}`,
    detail: `afterScroll=${thumbnailAfter}, rendered=${thumbnail?.tiles?.afterScroll?.renderedTiles || "?"}, conditional=${thumbnail?.cache?.conditionalRaw?.status || "?"}, range=${thumbnail?.cache?.rangeRaw?.status || "?"}.`
  });

  const large = artifacts["large-folder-ui-latest.json"]?.data;
  const largeReports = Array.isArray(large?.reports) ? large.reports : [];
  const largeClean = largeReports.every(
    (report) =>
      report?.listingRequests?.[0]?.isWindow === true &&
      Number(report?.windowFirst?.renderedRows || 0) > 0 &&
      Number(report?.windowFirst?.renderedRows || 0) <= 220 &&
      report?.windowFirst?.virtualized === false &&
      Number(report?.firstWindowPaintMs || Infinity) <= 2500 &&
      (report?.listingRequests || []).some((request) => request.isWindow === false) &&
      report?.virtualInitial?.virtualized === true &&
      Number(report?.virtualInitial?.renderedRows || 0) < 250 &&
      !(report?.header?.issues || []).length &&
      countPageErrors(report) === 0
  );
  addStatusCheck(
    checks,
    "large-folder-ui",
    "large-folder-clean",
    Number(large?.count || 0) >= 10000 && largeReports.length > 0 && largeClean,
    `large count=${large?.count || 0}; reports=${largeReports.length}; clean=${largeClean}.`
  );
  addMetric(metrics, checks, "large-folder-ui", "10k cold list API", large?.api?.coldWallMs, 5000, "large-folder-ui-latest.json");
  addMetric(metrics, checks, "large-folder-ui", "10k warm list API", large?.api?.warmWallMs, 3500, "large-folder-ui-latest.json");
  for (const report of largeReports) {
    addMetric(
      metrics,
      checks,
      "large-folder-ui",
      `10k first window paint ${report.viewport?.name || "viewport"}`,
      report?.firstWindowPaintMs,
      2500,
      "large-folder-ui-latest.json",
      `${report.viewport?.width || "?"}x${report.viewport?.height || "?"}`
    );
    addMetric(
      metrics,
      checks,
      "large-folder-ui",
      `10k first window rows ${report.viewport?.name || "viewport"}`,
      report?.windowFirst?.renderedRows,
      220,
      "large-folder-ui-latest.json",
      `${report.viewport?.width || "?"}x${report.viewport?.height || "?"}`,
      { unit: " rows" }
    );
    addMetric(
      metrics,
      checks,
      "large-folder-ui",
      `10k rendered rows ${report.viewport?.name || "viewport"}`,
      report?.virtualInitial?.renderedRows,
      250,
      "large-folder-ui-latest.json",
      `${report.viewport?.width || "?"}x${report.viewport?.height || "?"}`,
      { unit: " rows" }
    );
  }

  const large100k = artifacts["large-folder-100k-ui-latest.json"]?.data;
  const large100kReports = Array.isArray(large100k?.reports) ? large100k.reports : [];
  const large100kClean = large100kReports.every(
    (report) =>
      report?.listingRequests?.[0]?.isWindow === true &&
      Number(report?.windowFirst?.renderedRows || 0) > 0 &&
      Number(report?.windowFirst?.renderedRows || 0) <= 220 &&
      report?.windowFirst?.virtualized === false &&
      Number(report?.firstWindowPaintMs || Infinity) <= 750 &&
      Number(report?.fullHydrationMs || Infinity) <= 2000 &&
      (report?.listingRequests || []).some((request) => request.isWindow === false) &&
      report?.virtualInitial?.virtualized === true &&
      Number(report?.virtualInitial?.renderedRows || 0) <= 60 &&
      !(report?.header?.issues || []).length &&
      countPageErrors(report) === 0
  );
  addStatusCheck(
    checks,
    "large-folder-ui",
    "large-folder-100k-clean",
    Number(large100k?.count || 0) >= 100000 && large100kReports.length > 0 && large100kClean,
    `100k UI count=${large100k?.count || 0}; reports=${large100kReports.length}; clean=${large100kClean}.`
  );
  addMetric(metrics, checks, "large-folder-ui", "100k UI cold list API", large100k?.api?.coldWallMs, 3500, "large-folder-100k-ui-latest.json");
  addMetric(metrics, checks, "large-folder-ui", "100k UI compact warm list API", large100k?.api?.compactV2WarmWallMs, 1200, "large-folder-100k-ui-latest.json");
  addMetric(metrics, checks, "large-folder-ui", "100k UI expanded warm diagnostics", large100k?.api?.warmWallMs, 3000, "large-folder-100k-ui-latest.json");
  for (const report of large100kReports) {
    addMetric(
      metrics,
      checks,
      "large-folder-ui",
      `100k first window paint ${report.viewport?.name || "viewport"}`,
      report?.firstWindowPaintMs,
      750,
      "large-folder-100k-ui-latest.json",
      `${report.viewport?.width || "?"}x${report.viewport?.height || "?"}`
    );
    addMetric(
      metrics,
      checks,
      "large-folder-ui",
      `100k first window rows ${report.viewport?.name || "viewport"}`,
      report?.windowFirst?.renderedRows,
      220,
      "large-folder-100k-ui-latest.json",
      `${report.viewport?.width || "?"}x${report.viewport?.height || "?"}`,
      { unit: " rows" }
    );
    addMetric(
      metrics,
      checks,
      "large-folder-ui",
      `100k rendered rows ${report.viewport?.name || "viewport"}`,
      report?.virtualInitial?.renderedRows,
      60,
      "large-folder-100k-ui-latest.json",
      `${report.viewport?.width || "?"}x${report.viewport?.height || "?"}`,
      { unit: " rows" }
    );
    addMetric(
      metrics,
      checks,
      "large-folder-ui",
      `100k full hydration ${report.viewport?.name || "viewport"}`,
      report?.fullHydrationMs,
      2000,
      "large-folder-100k-ui-latest.json",
      `${report.viewport?.width || "?"}x${report.viewport?.height || "?"}`
    );
    addMetric(
      metrics,
      checks,
      "large-folder-ui",
      `100k client filter ${report.viewport?.name || "viewport"}`,
      report?.filterMs,
      2500,
      "large-folder-100k-ui-latest.json"
    );
  }

  const sizeAnalysisPerf = artifacts["size-analysis-perf-latest.json"]?.data;
  const sizeAnalysisHerd = sizeAnalysisPerf?.inFlightHerd || {};
  const sizeAnalysisHerdCount = Number(sizeAnalysisHerd.count || 0);
  const sizeAnalysisHerdJoined = Number(sizeAnalysisHerd.joined || 0);
  addStatusCheck(
    checks,
    "size-analysis",
    "size-analysis-perf-clean",
    sizeAnalysisPerf?.status === "pass" &&
      countFailedChecks(sizeAnalysisPerf) === 0 &&
      Number(sizeAnalysisPerf?.fixture?.count || 0) >= 10000 &&
      Number(sizeAnalysisHerd.origins || 0) === 1 &&
      sizeAnalysisHerdJoined >= Math.max(1, sizeAnalysisHerdCount - 1) &&
      sizeAnalysisPerf?.snapshots?.warm?.cache?.hit === true &&
      sizeAnalysisPerf?.snapshots?.afterMutation?.cache?.hit !== true &&
      sizeAnalysisPerf?.snapshots?.postMutationWarm?.cache?.hit === true &&
      sizeAnalysisPerf?.isolation?.analysis?.cache?.hit !== true &&
      Number(sizeAnalysisPerf?.isolation?.indexBuild?.count || 0) >= Number(sizeAnalysisPerf?.isolation?.expectedForegroundRows || 1) &&
      Number(sizeAnalysisPerf?.isolation?.operationCount || 0) >= 24 &&
      Number(sizeAnalysisPerf?.isolation?.failures?.length || 0) === 0 &&
      Number(sizeAnalysisPerf?.isolation?.foreground?.list?.minReturned || 0) >=
        Number(sizeAnalysisPerf?.isolation?.expectedForegroundRows || 1) &&
      Number(sizeAnalysisPerf?.isolation?.foreground?.nameSearch?.minReturned || 0) >= 1 &&
      Number(sizeAnalysisPerf?.isolation?.foreground?.nameSearch?.maxScanned ?? Infinity) <=
        Number(sizeAnalysisPerf?.budgets?.isolationSearchScannedBudget || 5),
    `sizeAnalysis status=${sizeAnalysisPerf?.status || "missing"}; count=${sizeAnalysisPerf?.fixture?.count || 0}; herd=${sizeAnalysisHerdJoined}/${sizeAnalysisHerdCount}; warmHit=${sizeAnalysisPerf?.snapshots?.warm?.cache?.hit}; isolationOps=${sizeAnalysisPerf?.isolation?.operationCount || 0}; isolationListP95=${sizeAnalysisPerf?.isolation?.foreground?.list?.p95Ms ?? "missing"}ms.`
  );
  addMetric(
    metrics,
    checks,
    "size-analysis",
    "10k Analyzer cold scan",
    sizeAnalysisPerf?.snapshots?.cold?.wallMs,
    sizeAnalysisPerf?.budgets?.coldWallBudgetMs || 12000,
    "size-analysis-perf-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "size-analysis",
    "10k Analyzer warm cache",
    sizeAnalysisPerf?.snapshots?.warm?.wallMs,
    sizeAnalysisPerf?.budgets?.warmWallBudgetMs || 250,
    "size-analysis-perf-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "size-analysis",
    "10k Analyzer after mutation",
    sizeAnalysisPerf?.snapshots?.afterMutation?.wallMs,
    sizeAnalysisPerf?.budgets?.afterMutationBudgetMs || 12000,
    "size-analysis-perf-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "size-analysis",
    "Foreground list while Analyzer scans p95",
    sizeAnalysisPerf?.isolation?.foreground?.list?.p95Ms,
    sizeAnalysisPerf?.budgets?.isolationListP95BudgetMs || 1500,
    "size-analysis-perf-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "size-analysis",
    "Foreground search while Analyzer scans p95",
    sizeAnalysisPerf?.isolation?.foreground?.nameSearch?.p95Ms,
    sizeAnalysisPerf?.budgets?.isolationSearchP95BudgetMs || 2000,
    "size-analysis-perf-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "size-analysis",
    "Foreground indexed search scanned while Analyzer scans",
    sizeAnalysisPerf?.isolation?.foreground?.nameSearch?.maxScanned,
    sizeAnalysisPerf?.budgets?.isolationSearchScannedBudget || 5,
    "size-analysis-perf-latest.json",
    "Active index search should stay token-narrowed during Analyzer scans.",
    { unit: " rows" }
  );
  addMetric(
    metrics,
    checks,
    "size-analysis",
    "Roots while Analyzer scans p95",
    sizeAnalysisPerf?.isolation?.foreground?.roots?.p95Ms,
    sizeAnalysisPerf?.budgets?.isolationRootsP95BudgetMs || 800,
    "size-analysis-perf-latest.json"
  );
  addMinimum(
    checks,
    "size-analysis",
    "size-analysis-cache-hit",
    sizeAnalysisPerf?.snapshots?.warm?.cache?.hit === true ? 1 : 0,
    1,
    "Repeat Analyzer scan cache hit"
  );
  addMinimum(
    checks,
    "size-analysis",
    "size-analysis-inflight-coalescing",
    sizeAnalysisHerdJoined,
    Math.max(1, sizeAnalysisHerdCount - 1),
    "Concurrent Analyzer scans should join one in-flight walk."
  );
  snapshots.push({
    name: "Size Analyzer cache",
    value: sizeAnalysisPerf?.snapshots?.warm?.cache?.hit === true ? "warm hit" : "missing",
    detail: `${sizeAnalysisPerf?.fixture?.count || 0} file fixture, herdJoined=${sizeAnalysisHerdJoined}/${sizeAnalysisHerdCount}, cold=${sizeAnalysisPerf?.snapshots?.cold?.wallMs ?? "?"}ms, warm=${sizeAnalysisPerf?.snapshots?.warm?.wallMs ?? "?"}ms, isolation list/search p95=${sizeAnalysisPerf?.isolation?.foreground?.list?.p95Ms ?? "?"}/${sizeAnalysisPerf?.isolation?.foreground?.nameSearch?.p95Ms ?? "?"}ms, afterMutation=${sizeAnalysisPerf?.snapshots?.afterMutation?.wallMs ?? "?"}ms.`
  });

  const sizeAnalysisCancel = artifacts["size-analysis-cancel-latest.json"]?.data;
  const cancelRestarted = Number(sizeAnalysisCancel?.follower?.cache?.restartedAfterAbortedInFlight || 0);
  const cancelRecovered =
    sizeAnalysisCancel?.follower?.cache?.source === "filesystem" &&
    (cancelRestarted >= 1 ||
      (sizeAnalysisCancel?.origin?.aborted === true &&
        Number(sizeAnalysisCancel?.follower?.scanned || 0) === Number(sizeAnalysisCancel?.fixture?.expectedScanned || 0)));
  addStatusCheck(
    checks,
    "size-analysis",
    "size-analysis-cancel-clean",
    sizeAnalysisCancel?.status === "pass" &&
      countFailedChecks(sizeAnalysisCancel) === 0 &&
      Number(sizeAnalysisCancel?.fixture?.count || 0) >= 10000 &&
      sizeAnalysisCancel?.origin?.aborted === true &&
      sizeAnalysisCancel?.follower?.ok === true &&
      cancelRecovered &&
      sizeAnalysisCancel?.warm?.cache?.hit === true &&
      Number(sizeAnalysisCancel?.foreground?.failures?.length || 0) === 0,
    `cancel status=${sizeAnalysisCancel?.status || "missing"}; originAborted=${sizeAnalysisCancel?.origin?.aborted}; recovery=${cancelRestarted >= 1 ? "joined-restart" : cancelRecovered ? "fresh-scan" : "missing"}; follower=${sizeAnalysisCancel?.follower?.wallMs ?? "missing"}ms; foreground list/roots p95=${sizeAnalysisCancel?.foreground?.list?.p95Ms ?? "missing"}/${sizeAnalysisCancel?.foreground?.roots?.p95Ms ?? "missing"}ms.`
  );
  addMetric(
    metrics,
    checks,
    "size-analysis",
    "Aborted Analyzer request release",
    sizeAnalysisCancel?.origin?.wallMs,
    sizeAnalysisCancel?.budgets?.abortBudgetMs || 2500,
    "size-analysis-cancel-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "size-analysis",
    "Recovered Analyzer scan after abort",
    sizeAnalysisCancel?.follower?.wallMs,
    sizeAnalysisCancel?.budgets?.followerBudgetMs || 15000,
    "size-analysis-cancel-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "size-analysis",
    "Analyzer warm cache after cancellation",
    sizeAnalysisCancel?.warm?.wallMs,
    sizeAnalysisCancel?.budgets?.warmBudgetMs || 250,
    "size-analysis-cancel-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "size-analysis",
    "Foreground list after Analyzer abort p95",
    sizeAnalysisCancel?.foreground?.list?.p95Ms,
    sizeAnalysisCancel?.budgets?.foregroundListBudgetMs || 1500,
    "size-analysis-cancel-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "size-analysis",
    "Foreground roots after Analyzer abort p95",
    sizeAnalysisCancel?.foreground?.roots?.p95Ms,
    sizeAnalysisCancel?.budgets?.foregroundRootsBudgetMs || 800,
    "size-analysis-cancel-latest.json"
  );
  addStatusCheck(
    checks,
    "size-analysis",
    "size-analysis-cancel-recovered-inflight",
    cancelRecovered,
    `Follower recovery=${cancelRestarted >= 1 ? "joined-restart" : cancelRecovered ? "fresh-scan" : "missing"}; scanned=${sizeAnalysisCancel?.follower?.scanned ?? "?"}/${sizeAnalysisCancel?.fixture?.expectedScanned ?? "?"}.`
  );
  snapshots.push({
    name: "Size Analyzer cancellation",
    value: sizeAnalysisCancel?.origin?.aborted === true && cancelRecovered ? "aborted and recovered" : "missing",
    detail: `${sizeAnalysisCancel?.fixture?.count || 0} file fixture, originAbort=${sizeAnalysisCancel?.origin?.wallMs ?? "?"}ms, follower=${sizeAnalysisCancel?.follower?.wallMs ?? "?"}ms, warm=${sizeAnalysisCancel?.warm?.wallMs ?? "?"}ms, foreground list/roots p95=${sizeAnalysisCancel?.foreground?.list?.p95Ms ?? "?"}/${sizeAnalysisCancel?.foreground?.roots?.p95Ms ?? "?"}ms.`
  });

  const network = artifacts["network-loopback-latest.json"]?.data;
  const networkChecks = network?.checks || {};
  addStatusCheck(
    checks,
    "network",
    "network-loopback-clean",
    network?.status === "pass" &&
      networkChecks?.diagnostics?.status === "pass" &&
      networkChecks?.diagnostics?.result?.kind === "unc" &&
      networkChecks?.indexSearch?.status === "pass",
    `network status=${network?.status || "missing"}; kind=${networkChecks?.diagnostics?.result?.kind || "missing"}.`
  );
  addMetric(metrics, checks, "network", "UNC diagnostics", networkChecks?.diagnostics?.wallMs, 5000, "network-loopback-latest.json");
  addMetric(metrics, checks, "network", "UNC cold list", networkChecks?.cold?.wallMs, 10000, "network-loopback-latest.json");
  addMetric(metrics, checks, "network", "UNC warm list", networkChecks?.warm?.wallMs, 7000, "network-loopback-latest.json");
  addMetric(metrics, checks, "network", "UNC folder index search", networkChecks?.indexSearch?.wallMs, 10000, "network-loopback-latest.json");

  const background = artifacts["background-index-latest.json"]?.data;
  addStatusCheck(
    checks,
    "background-index",
    "background-index-hits",
    Number(background?.nameSearch?.returned || 0) >= 1 &&
      Number(background?.labelSearch?.returned || 0) >= 1 &&
      Number(background?.contentSearch?.returned || 0) >= 1 &&
      Number(background?.root?.search?.contentIndexed || 0) >= 1,
    `name=${background?.nameSearch?.returned || 0}, label=${background?.labelSearch?.returned || 0}, content=${background?.contentSearch?.returned || 0}.`
  );
  addMetric(metrics, checks, "background-index", "Background index build", background?.root?.search?.buildMs, 8000, "background-index-latest.json");
  addMetric(metrics, checks, "background-index", "Background content search", background?.contentSearch?.searchMs, 1000, "background-index-latest.json");

  const backgroundIsolation = artifacts["background-index-isolation-latest.json"]?.data;
  addStatusCheck(
    checks,
    "background-index",
    "background-index-isolation-clean",
    backgroundIsolation?.status === "pass" &&
      countFailedChecks(backgroundIsolation) === 0 &&
      Number(backgroundIsolation?.runningSamples || 0) >= 1 &&
      Number(backgroundIsolation?.backgroundSearch?.returned || 0) >= 1,
    `runningSamples=${backgroundIsolation?.runningSamples || 0}; foreground list p95=${backgroundIsolation?.latency?.list?.p95Ms ?? "missing"}ms; search p95=${backgroundIsolation?.latency?.search?.p95Ms ?? "missing"}ms.`
  );
  addMetric(
    metrics,
    checks,
    "background-index",
    "Foreground list while indexing p95",
    backgroundIsolation?.latency?.list?.p95Ms,
    backgroundIsolation?.budgets?.listP95Ms || 2500,
    "background-index-isolation-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "background-index",
    "Foreground search while indexing p95",
    backgroundIsolation?.latency?.search?.p95Ms,
    backgroundIsolation?.budgets?.searchP95Ms || 2000,
    "background-index-isolation-latest.json"
  );
  snapshots.push({
    name: "Index isolation",
    value: `${backgroundIsolation?.runningSamples || 0}/${backgroundIsolation?.samples?.length || 0}`,
    detail: `foreground list p95=${backgroundIsolation?.latency?.list?.p95Ms ?? "?"}ms, search p95=${backgroundIsolation?.latency?.search?.p95Ms ?? "?"}ms while background content index was running.`
  });

  const backgroundFreshness = artifacts["background-index-freshness-latest.json"]?.data;
  const backgroundFreshnessAutoRebuild =
    backgroundFreshness?.autoRebuild ||
    backgroundFreshness?.staleOverview?.autoRebuild ||
    backgroundFreshness?.staleOverview?.freshness?.autoRebuild;
  addStatusCheck(
    checks,
    "background-index",
    "background-index-freshness",
    backgroundFreshness?.status === "pass" &&
      countFailedChecks(backgroundFreshness) === 0 &&
      backgroundFreshness?.staleOverview?.freshness?.stale === true &&
      (backgroundFreshnessAutoRebuild?.scheduled === true || backgroundFreshnessAutoRebuild?.active === true) &&
      backgroundFreshness?.rebuiltOverview?.freshness?.status === "fresh" &&
      backgroundFreshness?.rebuiltSearch?.hit === true,
    `stale=${backgroundFreshness?.staleOverview?.freshness?.reason || "missing"}; auto=${backgroundFreshnessAutoRebuild?.scheduled === true}; rebuilt=${backgroundFreshness?.rebuiltOverview?.freshness?.status || "missing"}.`
  );

  const backgroundWatch = artifacts["background-index-watch-latest.json"]?.data;
  addStatusCheck(
    checks,
    "background-index",
    "background-index-watch",
    backgroundWatch?.status === "pass" &&
      countFailedChecks(backgroundWatch) === 0 &&
      backgroundWatch?.initialOverview?.watcher?.available === true &&
      backgroundWatch?.rebuiltOverview?.watcher?.lastAutoRebuild?.source === "watch" &&
      backgroundWatch?.rebuiltSearch?.hit === true &&
      (backgroundWatch?.checks || []).some((item) => item.id === "watch-burst-debounced" && item.status === "pass") &&
      Number(backgroundWatch?.burstSearch?.hits || 0) === Number(backgroundWatch?.paths?.burstPaths?.length || 0) &&
      Number(backgroundWatch?.paths?.burstPaths?.length || 0) >= 8 &&
      (backgroundWatch?.checks || []).some((item) => item.id === "watch-delete-rename-removes-stale-hit" && item.status === "pass") &&
      backgroundWatch?.deleteRenameSearch?.renamedPresent === true &&
      backgroundWatch?.deleteRenameSearch?.deletedPresent === false &&
      backgroundWatch?.deleteRenameSearch?.oldNamePresent === false &&
      Number(backgroundWatch?.deleteRenameSearch?.hits || 0) === Number(backgroundWatch?.paths?.burstPaths?.length || 0) - 1 &&
      backgroundWatch?.restartOverview?.watcher?.lastAutoRebuild?.source === "watch" &&
      backgroundWatch?.restartSearch?.hit === true &&
      Number(backgroundWatch?.restartJobs?.length || 0) <= 1,
    `watch=${backgroundWatch?.rebuiltOverview?.watcher?.lastAutoRebuild?.source || "missing"}; events=${backgroundWatch?.burstOverview?.watcher?.eventCount || 0}; burstHits=${backgroundWatch?.burstSearch?.hits || 0}; deleteRenameHits=${backgroundWatch?.deleteRenameSearch?.hits || 0}; restart=${backgroundWatch?.restartOverview?.watcher?.lastAutoRebuild?.source || "missing"}.`
  );

  const backgroundOperation = artifacts["background-index-operation-latest.json"]?.data;
  const operationInvalidation = backgroundOperation?.createOperation?.result?.backgroundIndexInvalidation;
  const operationAffectedRoot = (operationInvalidation?.roots || []).find((root) => root.id === backgroundOperation?.rootId);
  addStatusCheck(
    checks,
    "background-index",
    "background-index-operation-invalidation",
    backgroundOperation?.status === "pass" &&
      countFailedChecks(backgroundOperation) === 0 &&
      backgroundOperation?.initialOverview?.watcher?.enabled === false &&
      operationAffectedRoot?.autoRebuild?.source === "operation" &&
      (operationAffectedRoot?.autoRebuild?.scheduled === true || operationAffectedRoot?.autoRebuild?.active === true) &&
      backgroundOperation?.rebuiltOverview?.lastAutoRebuildReason === "operation:create-file" &&
      backgroundOperation?.rebuiltSearch?.hit === true,
    `operationIndex status=${backgroundOperation?.status || "missing"}; affected=${operationInvalidation?.affected ?? "missing"}; source=${operationAffectedRoot?.autoRebuild?.source || "missing"}; hit=${backgroundOperation?.rebuiltSearch?.hit}.`
  );

  const scriptingMutation = artifacts["scripting-mutation-cache-latest.json"]?.data;
  const scriptBackgroundInvalidation = scriptingMutation?.scriptResult?.backgroundIndexInvalidation;
  const scriptAffectedRoot = (scriptBackgroundInvalidation?.roots || []).find((root) => root.id === scriptingMutation?.rootId);
  addStatusCheck(
    checks,
    "background-index",
    "scripting-mutation-cache-invalidation",
    scriptingMutation?.status === "pass" &&
      countFailedChecks(scriptingMutation) === 0 &&
      scriptingMutation?.listing?.afterScript?.cache?.hit !== true &&
      scriptingMutation?.listing?.postScriptWarm?.cache?.hit === true &&
      scriptAffectedRoot?.autoRebuild?.source === "script" &&
      (scriptAffectedRoot?.autoRebuild?.scheduled === true || scriptAffectedRoot?.autoRebuild?.active === true) &&
      scriptingMutation?.rebuiltOverview?.lastAutoRebuildReason === "script" &&
      scriptingMutation?.rebuiltSearch?.hit === true,
    `scriptMutation status=${scriptingMutation?.status || "missing"}; affected=${scriptBackgroundInvalidation?.affected ?? "missing"}; source=${scriptAffectedRoot?.autoRebuild?.source || "missing"}; listingHit=${scriptingMutation?.listing?.afterScript?.cache?.hit}; rebuiltHit=${scriptingMutation?.rebuiltSearch?.hit}.`
  );

  const backgroundRestart = artifacts["background-index-restart-latest.json"]?.data;
  addStatusCheck(
    checks,
    "background-index",
    "background-index-restart-hits",
    Number(backgroundRestart?.after?.nameTiming?.returned || 0) >= 1 &&
      Number(backgroundRestart?.after?.labelTiming?.returned || 0) >= 1 &&
      Number(backgroundRestart?.after?.contentTiming?.returned || 0) >= 1 &&
      backgroundRestart?.after?.overview?.job === null,
    `after name=${backgroundRestart?.after?.nameTiming?.returned || 0}, label=${backgroundRestart?.after?.labelTiming?.returned || 0}, content=${backgroundRestart?.after?.contentTiming?.returned || 0}.`
  );
  addMetric(
    metrics,
    checks,
    "background-index",
    "Restart warm content search",
    backgroundRestart?.after?.contentTiming?.searchMs,
    1000,
    "background-index-restart-latest.json"
  );

  const backgroundConcurrency = artifacts["background-index-concurrency-latest.json"]?.data;
  const backgroundHerd = backgroundConcurrency?.herd || {};
  const backgroundHerdCount = Number(backgroundHerd.count || 0);
  const backgroundHerdJoined = Number(backgroundHerd.joined || 0);
  addStatusCheck(
    checks,
    "background-index",
    "background-index-concurrency",
    backgroundConcurrency?.status === "pass" &&
      countFailedChecks(backgroundConcurrency) === 0 &&
      Number(backgroundConcurrency?.fixture?.count || 0) >= 20000 &&
      Number(backgroundHerd.origins || 0) === 1 &&
      backgroundHerdJoined >= Math.max(1, backgroundHerdCount - 1) &&
      backgroundConcurrency?.warm?.source === "background-search-store-cache",
    `backgroundConcurrency status=${backgroundConcurrency?.status || "missing"}; herd=${backgroundHerdJoined}/${backgroundHerdCount}; origin=${backgroundHerd.origins ?? "missing"}; warm=${backgroundConcurrency?.warm?.source || "missing"}.`
  );
  addMetric(
    metrics,
    checks,
    "background-index",
    "Background restarted search herd",
    backgroundHerd.wallMs,
    backgroundConcurrency?.budgets?.herdWallBudgetMs || 2500,
    "background-index-concurrency-latest.json"
  );
  addMetric(
    metrics,
    checks,
    "background-index",
    "Background post-herd warm search",
    backgroundConcurrency?.warm?.wallMs,
    backgroundConcurrency?.budgets?.warmWallBudgetMs || 250,
    "background-index-concurrency-latest.json"
  );

  const backgroundToken = artifacts["background-index-token-search-latest.json"]?.data;
  addStatusCheck(
    checks,
    "background-index",
    "background-index-token-search",
    backgroundToken?.status === "pass" &&
      countFailedChecks(backgroundToken) === 0 &&
      backgroundToken?.search?.hit === true &&
      Number(backgroundToken?.search?.timing?.tokenNarrowedStores || 0) >= 1 &&
      Number(backgroundToken?.search?.timing?.storeCacheHits || 0) >= 1 &&
      Number(backgroundToken?.repeatSearch?.timing?.storeCacheHits || 0) >= 1 &&
      Number(backgroundToken?.search?.timing?.scanned || Infinity) <= Number(backgroundToken?.budgets?.scannedBudget || 5),
    `tokenSearch status=${backgroundToken?.status || "missing"}; scanned=${backgroundToken?.search?.timing?.scanned ?? "missing"}; narrowed=${backgroundToken?.search?.timing?.tokenNarrowedStores ?? "missing"}; cacheHits=${backgroundToken?.search?.timing?.storeCacheHits ?? "missing"}.`
  );
  addMetric(
    metrics,
    checks,
    "background-index",
    "Background token search scanned",
    backgroundToken?.search?.timing?.scanned,
    backgroundToken?.budgets?.scannedBudget || 5,
    "background-index-token-search-latest.json",
    "Exact tokenized search should avoid scanning the full background index.",
    { unit: " rows" }
  );
  addMetric(
    metrics,
    checks,
    "background-index",
    "Background token search wall",
    backgroundToken?.search?.wallMs,
    backgroundToken?.budgets?.wallBudgetMs || 1200,
    "background-index-token-search-latest.json"
  );
  addMinimum(
    checks,
    "background-index",
    "background-token-store-cache-hit",
    backgroundToken?.search?.timing?.storeCacheHits,
    1,
    "Background token search store cache hits"
  );
  snapshots.push({
    name: "Token index search",
    value: `${backgroundToken?.search?.timing?.scanned ?? "?"} scanned`,
    detail: `${backgroundToken?.fixture?.count || 0} file index, wall=${backgroundToken?.search?.wallMs ?? "?"}ms, cacheHits=${backgroundToken?.search?.timing?.storeCacheHits ?? "?"}, tokens=${backgroundToken?.root?.search?.tokenIndex?.tokens ?? "?"}.`
  });

  const speedUi = artifacts["speed-index-ui-latest.json"]?.data;
  addStatusCheck(
    checks,
    "speed-ui",
    "speed-index-ui-clean",
    speedUi?.status === "pass" &&
      countFailedChecks(speedUi) === 0 &&
      Number(speedUi?.layout?.issues?.length || 0) === 0 &&
      Number(speedUi?.endpointCounts?.["/api/index/build"] || 0) >= 1 &&
      Number(speedUi?.endpointCounts?.["/api/background-indexes/search"] || 0) >= 1 &&
      Number(speedUi?.background?.metrics?.["bg-watched"]?.value || 0) >= 1 &&
      (speedUi?.backgroundRecoveredSearch?.resultButtons || []).some(
        (item) => item.path === speedUi?.fixturePaths?.stalePath && /velvet compass/i.test(String(item.text || ""))
      ),
    `Speed UI status=${speedUi?.status || "missing"}; layoutIssues=${speedUi?.layout?.issues?.length || 0}.`
  );
  addMetric(
    metrics,
    checks,
    "speed-ui",
    "Visible Speed index build",
    parseMsText(speedUi?.folderIndex?.metrics?.build?.value),
    5000,
    "speed-index-ui-latest.json",
    speedUi?.folderIndex?.summary || ""
  );

  const searchBackgroundUi = artifacts["search-background-ui-latest.json"]?.data;
  addStatusCheck(
    checks,
    "search-ui",
    "search-background-ui-clean",
    searchBackgroundUi?.status === "pass" &&
      countFailedChecks(searchBackgroundUi) === 0 &&
      Number(searchBackgroundUi?.layout?.issues?.length || 0) === 0 &&
      Number(searchBackgroundUi?.endpointCounts?.["/api/background-indexes/search"] || 0) >= 2 &&
      Number(searchBackgroundUi?.endpointCounts?.["/api/search"] || 0) >= 2,
    `Search UI status=${searchBackgroundUi?.status || "missing"}; layoutIssues=${searchBackgroundUi?.layout?.issues?.length || 0}.`
  );
  addMetric(
    metrics,
    checks,
    "search-ui",
    "Visible Search warm content",
    parseMsText(searchBackgroundUi?.contentSearch?.summary),
    1000,
    "search-background-ui-latest.json",
    searchBackgroundUi?.contentSearch?.summary || ""
  );

  const summary = {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length
  };
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    status: summary.fail ? "fail" : summary.warn ? "warn" : "pass",
    maxAgeHours,
    failOnTrendRegression,
    summary,
    areas: areaSummaries(checks),
    snapshots,
    metrics,
    hotMetrics: hottestMetrics(metrics, 14),
    checks
  };

  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`speed health: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  console.log(`hottest metric: ${report.hotMetrics[0]?.name || "n/a"} (${report.hotMetrics[0]?.percentOfBudget ?? "n/a"}% budget)`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
