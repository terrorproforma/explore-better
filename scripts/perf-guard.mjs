import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const benchmarkJsonPath = path.join(artifactsDir, "perf-benchmark-latest.json");
const guardJsonPath = path.join(artifactsDir, "perf-guard-latest.json");
const guardMdPath = path.join(artifactsDir, "perf-guard-latest.md");
const trendHistoryPath = path.join(artifactsDir, "perf-trend-history.jsonl");
const trendJsonPath = path.join(artifactsDir, "perf-trend-latest.json");
const trendMdPath = path.join(artifactsDir, "perf-trend-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function numberOption(name, fallback) {
  const value = Number(optionValue(name, process.env[name.replace(/^--/, "EB_PERF_GUARD_").replace(/-/g, "_").toUpperCase()] || fallback));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function guardCounts() {
  return optionValue("--counts", process.env.EB_PERF_GUARD_COUNTS || "1000");
}

function guardMediaCounts() {
  return optionValue("--media-counts", process.env.EB_PERF_GUARD_MEDIA_COUNTS || "50");
}

function guardContentCounts() {
  return optionValue("--content-counts", process.env.EB_PERF_GUARD_CONTENT_COUNTS || "500");
}

function guardRepetitions() {
  const value = Number(optionValue("--repetitions", process.env.EB_PERF_GUARD_REPETITIONS || "3"));
  return Number.isInteger(value) && value >= 1 && value <= 7 ? value : 3;
}

function guardBudgets() {
  return {
    coldListWallMs: numberOption("--cold-list-wall-ms", 5000),
    warmListWallMs: numberOption("--warm-list-wall-ms", 3500),
    warmListApiMs: numberOption("--warm-list-api-ms", 2500),
    broadFilterWallMs: numberOption("--broad-filter-wall-ms", 250),
    narrowFilterWallMs: numberOption("--narrow-filter-wall-ms", 250),
    apiSearchWallMs: numberOption("--api-search-wall-ms", 2500),
    indexBuildWallMs: numberOption("--index-build-wall-ms", 5000),
    indexSearchWallMs: numberOption("--index-search-wall-ms", 800),
    backgroundSearchWallMs: numberOption("--background-search-wall-ms", 800),
    imageWarmWallMs: numberOption("--image-warm-wall-ms", 2500),
    imageIndexBuildWallMs: numberOption("--image-index-build-wall-ms", 5000),
    contentBuildWallMs: numberOption("--content-build-wall-ms", 8000),
    contentSearchWallMs: numberOption("--content-search-wall-ms", 1000),
    networkColdWallMs: numberOption("--network-cold-wall-ms", 10000),
    networkWarmWallMs: numberOption("--network-warm-wall-ms", 7000),
    networkSearchWallMs: numberOption("--network-search-wall-ms", 10000)
  };
}

function trendRegressionFactor() {
  const value = Number(
    optionValue(
      "--trend-regression-factor",
      process.env.EB_PERF_TREND_REGRESSION_FACTOR || process.env.EB_PERF_GUARD_TREND_REGRESSION_FACTOR || "1.5"
    )
  );
  return Number.isFinite(value) && value > 1 ? value : 1.5;
}

function trendMinimumDeltaMs() {
  const value = Number(
    optionValue(
      "--trend-min-delta-ms",
      process.env.EB_PERF_TREND_MIN_DELTA_MS || process.env.EB_PERF_GUARD_TREND_MIN_DELTA_MS || "25"
    )
  );
  return Number.isFinite(value) && value >= 0 ? value : 25;
}

function trendHistoryLimit() {
  const value = Number(
    optionValue(
      "--trend-history-limit",
      process.env.EB_PERF_TREND_HISTORY_LIMIT || process.env.EB_PERF_GUARD_TREND_HISTORY_LIMIT || "200"
    )
  );
  return Number.isInteger(value) && value > 0 ? value : 200;
}

function trendMinimumSamples() {
  const value = Number(
    optionValue(
      "--trend-min-samples",
      process.env.EB_PERF_TREND_MIN_SAMPLES || "3"
    )
  );
  return Number.isInteger(value) && value >= 1 ? value : 3;
}

function failOnTrendRegression() {
  return process.argv.includes("--fail-on-trend-regression") || process.env.EB_PERF_TREND_FAIL_ON_REGRESSION === "1";
}

function runProcess(file, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: workspace,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ code: -1, stdout, stderr: error.message });
    });
    child.on("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function rounded(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null;
}

function assertBudget(checks, name, actual, budget, detail = "") {
  const numeric = Number(actual);
  const passed = Number.isFinite(numeric) && numeric <= budget;
  checks.push({
    name,
    status: passed ? "pass" : "fail",
    actual: rounded(numeric),
    budget,
    detail
  });
}

function assertMinimum(checks, name, actual, minimum, detail = "") {
  const numeric = Number(actual);
  const passed = Number.isFinite(numeric) && numeric >= minimum;
  checks.push({
    name,
    status: passed ? "pass" : "fail",
    actual: rounded(numeric),
    budget: `>= ${minimum}`,
    detail
  });
}

function evaluateReport(report, budgets) {
  const checks = [];
  for (const run of report.runs || []) {
    const prefix = `${run.count} files`;
    assertMinimum(checks, `${prefix}: listed entries`, run.cold?.result?.returned, run.count, run.path);
    assertBudget(checks, `${prefix}: cold list wall`, run.cold?.wallMs, budgets.coldListWallMs, run.path);
    assertBudget(checks, `${prefix}: warm list wall`, run.warm?.wallMs, budgets.warmListWallMs, run.path);
    assertBudget(checks, `${prefix}: warm list API`, run.warm?.result?.totalMs, budgets.warmListApiMs, run.path);
    assertBudget(checks, `${prefix}: broad filter`, run.filterBroad?.wallMs, budgets.broadFilterWallMs, run.path);
    assertBudget(checks, `${prefix}: narrow filter`, run.filterNarrow?.wallMs, budgets.narrowFilterWallMs, run.path);
    assertBudget(checks, `${prefix}: API search`, run.apiSearch?.wallMs, budgets.apiSearchWallMs, run.path);
    assertBudget(checks, `${prefix}: index build`, run.indexBuild?.wallMs, budgets.indexBuildWallMs, run.path);
    assertBudget(checks, `${prefix}: index search`, run.indexSearch?.wallMs, budgets.indexSearchWallMs, run.path);
    assertMinimum(checks, `${prefix}: index search returned`, run.indexSearch?.result?.results?.length || run.indexSearch?.result?.returned, 1, run.path);
    assertBudget(
      checks,
      `${prefix}: background search`,
      run.backgroundIndex?.search?.wallMs,
      budgets.backgroundSearchWallMs,
      run.path
    );
    assertMinimum(
      checks,
      `${prefix}: background search returned`,
      run.backgroundIndex?.search?.result?.returned,
      1,
      run.path
    );
  }

  for (const run of report.mediaRuns || []) {
    const prefix = `${run.count} images`;
    assertMinimum(checks, `${prefix}: listed entries`, run.cold?.result?.returned, run.count, run.path);
    assertBudget(checks, `${prefix}: warm image list`, run.warm?.wallMs, budgets.imageWarmWallMs, run.path);
    const listingCacheHit = run.warm?.result?.cache?.hit === true && Number(run.warm?.result?.scanned) === 0;
    const dimensionCacheHits = Number(run.warm?.result?.dimensionsCache?.hits || 0);
    checks.push({
      name: `${prefix}: warm metadata cache`,
      status: listingCacheHit || dimensionCacheHits >= 1 ? "pass" : "fail",
      actual: listingCacheHit ? "listing cache, zero scan" : `${dimensionCacheHits} dimension hits`,
      budget: "validated listing cache or >= 1 dimension hit",
      detail: run.path
    });
    assertBudget(checks, `${prefix}: image index build`, run.indexBuild?.wallMs, budgets.imageIndexBuildWallMs, run.path);
  }

  for (const run of report.contentRuns || []) {
    const prefix = `${run.count} content files`;
    assertBudget(checks, `${prefix}: content index build`, run.buildWallMs, budgets.contentBuildWallMs, run.path);
    assertMinimum(checks, `${prefix}: content indexed`, run.root?.search?.contentIndexed, 1, run.path);
    assertBudget(checks, `${prefix}: content search`, run.search?.wallMs, budgets.contentSearchWallMs, run.path);
    assertMinimum(checks, `${prefix}: content search returned`, run.search?.result?.returned, 1, run.path);
  }

  for (const run of report.networkRuns || []) {
    if (run.error) {
      checks.push({
        name: `network ${run.path}: reachable`,
        status: "fail",
        actual: run.error,
        budget: "reachable",
        detail: run.path
      });
      continue;
    }
    assertBudget(checks, `network ${run.path}: cold list`, run.cold?.wallMs, budgets.networkColdWallMs, run.path);
    assertBudget(checks, `network ${run.path}: warm list`, run.warm?.wallMs, budgets.networkWarmWallMs, run.path);
    assertBudget(checks, `network ${run.path}: index/search`, run.search?.wallMs, budgets.networkSearchWallMs, run.path);
  }

  return checks;
}

function aggregateCheckRuns(checkRuns) {
  const templates = checkRuns[0] || [];
  return templates.map((template) => {
    const samples = checkRuns.map((checks) => checks.find((check) => check.name === template.name)).filter(Boolean);
    const numericValues = samples.map((sample) => Number(sample.actual)).filter(Number.isFinite);
    const completeNumericSet = numericValues.length === checkRuns.length;
    if (completeNumericSet) {
      const actual = rounded(median(numericValues));
      const minimumMatch = typeof template.budget === "string" ? template.budget.match(/^>=\s*([\d.]+)$/) : null;
      const passed = minimumMatch
        ? actual >= Number(minimumMatch[1])
        : Number.isFinite(Number(template.budget)) && actual <= Number(template.budget);
      return {
        ...template,
        status: passed ? "pass" : "fail",
        actual,
        samples: numericValues.map(rounded),
        detail: `${template.detail || ""}${template.detail ? " / " : ""}median of ${checkRuns.length}`
      };
    }
    return {
      ...template,
      status: samples.length === checkRuns.length && samples.every((sample) => sample.status === "pass") ? "pass" : "fail",
      samples: samples.map((sample) => sample.actual),
      detail: `${template.detail || ""}${template.detail ? " / " : ""}${checkRuns.length} repetitions`
    };
  });
}

async function readTrendHistory() {
  try {
    const text = await fs.readFile(trendHistoryPath, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function trendableMetrics(checks) {
  return checks
    .filter((check) => Number.isFinite(Number(check.actual)) && Number.isFinite(Number(check.budget)))
    .map((check) => ({
      name: check.name,
      actual: rounded(check.actual),
      budget: rounded(check.budget),
      detail: check.detail || ""
    }));
}

function trendMethodology(guardReport) {
  const prefix = Number(guardReport.repetitions) > 1 ? "fresh-process-median-v2" : "single-process-v2";
  const environment = guardReport.environment || {};
  const storage = environment.oneDrive?.fixtureWithinSyncRoot ? "onedrive" : "local";
  return `${prefix}:${storage}:${environment.activeProcessLoad || "unknown"}`;
}

function entryMethodology(entry) {
  return entry.methodology || "single-process-v1";
}

function aggregateEnvironment(benchmarks) {
  const latest = benchmarks.at(-1)?.environment || {};
  const cpuSamples = benchmarks
    .map((benchmark) => Number(benchmark.environment?.systemCpuLoadPercent))
    .filter(Number.isFinite);
  const systemCpuLoadPercent = rounded(median(cpuSamples));
  const activeProcessLoad = systemCpuLoadPercent === null
    ? "unknown"
    : systemCpuLoadPercent < 20
      ? "light"
      : systemCpuLoadPercent < 50
        ? "moderate"
        : "heavy";
  return {
    ...latest,
    systemCpuLoadPercent,
    activeProcessLoad,
    cpuLoadSamples: cpuSamples.map(rounded)
  };
}

function historyMetricValues(history, metricName, methodology) {
  const values = [];
  for (const entry of history) {
    if (entryMethodology(entry) !== methodology) continue;
    const metric = (entry.metrics || []).find((item) => item.name === metricName);
    if (metric && Number.isFinite(Number(metric.actual))) {
      values.push(Number(metric.actual));
    }
  }
  return values;
}

function buildTrendReport(history, guardReport, benchmark) {
  const metrics = trendableMetrics(guardReport.checks);
  const methodology = trendMethodology(guardReport);
  const comparableHistory = history.filter((entry) => entryMethodology(entry) === methodology);
  const factor = trendRegressionFactor();
  const minimumDeltaMs = trendMinimumDeltaMs();
  const minimumSamples = trendMinimumSamples();
  const comparisons = metrics.map((metric) => {
    const previousValues = historyMetricValues(history, metric.name, methodology);
    const previousMedian = median(previousValues);
    const baselineReady = previousValues.length >= minimumSamples;
    const deltaMs = previousMedian === null ? null : rounded(metric.actual - previousMedian);
    const ratio = previousMedian && previousMedian > 0 ? rounded(metric.actual / previousMedian) : null;
    const regression =
      baselineReady &&
      previousMedian !== null &&
      metric.actual > previousMedian * factor &&
      metric.actual - previousMedian >= minimumDeltaMs;
    const improvement =
      baselineReady &&
      previousMedian !== null &&
      metric.actual < previousMedian / factor &&
      previousMedian - metric.actual >= minimumDeltaMs;
    return {
      name: metric.name,
      actual: metric.actual,
      budget: metric.budget,
      previousSamples: previousValues.length,
      previousMedian: rounded(previousMedian),
      deltaMs,
      ratio,
      status: regression ? "regression" : improvement ? "improvement" : baselineReady ? "steady" : previousValues.length ? "baseline" : "new",
      detail: metric.detail
    };
  });
  const regressions = comparisons.filter((comparison) => comparison.status === "regression");
  const improvements = comparisons.filter((comparison) => comparison.status === "improvement");
  return {
    generatedAt: new Date().toISOString(),
    status: regressions.length ? "watch" : "ok",
    methodology,
    factor,
    minimumDeltaMs,
    minimumSamples,
    historyEntries: comparableHistory.length,
    totalHistoryEntries: history.length,
    benchmark: benchmarkJsonPath,
    guard: guardJsonPath,
    environment: {
      platform: benchmark.platform,
      cpuCount: benchmark.cpuCount,
      node: benchmark.node,
      ...benchmark.environment
    },
    comparisons,
    regressions,
    improvements
  };
}

function historyEntryFromReports(guardReport, benchmark, trendReport) {
  return {
    generatedAt: guardReport.generatedAt,
    status: guardReport.status,
    trendStatus: trendReport.status,
    methodology: trendMethodology(guardReport),
    repetitions: guardReport.repetitions || 1,
    environment: {
      platform: benchmark.platform,
      cpuCount: benchmark.cpuCount,
      node: benchmark.node,
      ...benchmark.environment
    },
    counts: {
      runs: (benchmark.runs || []).map((run) => run.count),
      mediaRuns: (benchmark.mediaRuns || []).map((run) => run.count),
      contentRuns: (benchmark.contentRuns || []).map((run) => run.count),
      networkRuns: (benchmark.networkRuns || []).map((run) => run.path)
    },
    metrics: trendableMetrics(guardReport.checks)
  };
}

async function appendTrendHistory(entry, limit) {
  const history = await readTrendHistory();
  const nextHistory = [...history, entry].slice(-limit);
  await fs.writeFile(trendHistoryPath, `${nextHistory.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  return nextHistory.length;
}

function markdownGuard(report) {
  const rows = report.checks
    .map((check) => `| ${check.status} | ${check.name} | ${check.actual ?? ""} | ${check.budget} | ${check.detail || ""} |`)
    .join("\n");
  return `# Explore Better Performance Guard

Generated: ${report.generatedAt}

Status: ${report.status}

Benchmark: \`${benchmarkJsonPath}\`

Trend: \`${trendJsonPath}\`

Measured repetitions: ${report.repetitions}; numeric checks use the median and functional checks must pass every run.

| Status | Check | Actual | Budget | Detail |
| --- | --- | ---: | ---: | --- |
${rows}

Budgets can be adjusted with \`EB_PERF_GUARD_*\` environment variables or the matching CLI flags, for example \`--warm-list-wall-ms=4000\`.
`;
}

function markdownTrend(report) {
  const comparisonRows = report.comparisons
    .map(
      (item) =>
        `| ${item.status} | ${item.name} | ${item.actual ?? ""} | ${item.previousMedian ?? ""} | ${item.deltaMs ?? ""} | ${
          item.ratio ?? ""
        } | ${item.previousSamples} |`
    )
    .join("\n");
  const regressionSection = report.regressions.length
    ? `
## Regression Watch

${report.regressions.map((item) => `- ${item.name}: ${item.actual} ms vs historical median ${item.previousMedian} ms`).join("\n")}
`
    : "";
  const improvementSection = report.improvements.length
    ? `
## Improvements

${report.improvements.map((item) => `- ${item.name}: ${item.actual} ms vs historical median ${item.previousMedian} ms`).join("\n")}
`
    : "";
  return `# Explore Better Performance Trend

Generated: ${report.generatedAt}

Status: ${report.status}

Methodology: ${report.methodology}

Comparable history entries before this run: ${report.historyEntries} of ${report.totalHistoryEntries}

Regression threshold: ${report.factor}x and at least ${report.minimumDeltaMs} ms slower than historical median.

| Status | Metric | Current | Historical median | Delta ms | Ratio | Samples |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
${comparisonRows}
${regressionSection}
${improvementSection}
Artifacts:
- Guard: \`${guardJsonPath}\`
- Benchmark: \`${benchmarkJsonPath}\`
- History: \`${trendHistoryPath}\`
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const budgets = guardBudgets();
  const benchmarkArgs = [
    "scripts/perf-benchmark.mjs",
    `--counts=${guardCounts()}`,
    `--media-counts=${guardMediaCounts()}`,
    `--content-counts=${guardContentCounts()}`
  ];
  const networkPaths = optionValue("--network-paths", process.env.EB_PERF_GUARD_NETWORK_PATHS || "");
  if (networkPaths) {
    benchmarkArgs.push(`--network-paths=${networkPaths}`);
  }
  const fixture = optionValue("--fixture", process.env.EB_PERF_GUARD_FIXTURE || "");
  if (fixture) {
    benchmarkArgs.push(`--fixture=${fixture}`);
  }
  const repetitions = guardRepetitions();
  const benchmarks = [];
  const checkRuns = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const result = await runProcess(process.execPath, benchmarkArgs);
    if (result.stdout.trim()) {
      console.log(`[perf guard ${repetition}/${repetitions}]\n${result.stdout.trim()}`);
    }
    if (result.stderr.trim()) {
      console.error(result.stderr.trim());
    }
    if (result.code !== 0) {
      throw new Error(`Performance benchmark repetition ${repetition} failed with exit code ${result.code}.`);
    }
    const sample = JSON.parse(await fs.readFile(benchmarkJsonPath, "utf8"));
    benchmarks.push(sample);
    checkRuns.push(evaluateReport(sample, budgets));
  }

  const benchmark = benchmarks[benchmarks.length - 1];
  const environment = aggregateEnvironment(benchmarks);
  const checks = aggregateCheckRuns(checkRuns);
  const failures = checks.filter((check) => check.status === "fail");
  const guardReport = {
    generatedAt: new Date().toISOString(),
    status: failures.length ? "fail" : "pass",
    repetitions,
    sampleGeneratedAt: benchmarks.map((sample) => sample.generatedAt),
    environment,
    budgets,
    benchmark: benchmarkJsonPath,
    checks,
    failures
  };
  const existingHistory = await readTrendHistory();
  const trendBenchmark = { ...benchmark, environment };
  const trendReport = buildTrendReport(existingHistory, guardReport, trendBenchmark);
  const savedHistoryEntries = await appendTrendHistory(
    historyEntryFromReports(guardReport, trendBenchmark, trendReport),
    trendHistoryLimit()
  );
  trendReport.savedHistoryEntries = savedHistoryEntries;
  await fs.writeFile(guardJsonPath, `${JSON.stringify(guardReport, null, 2)}\n`, "utf8");
  await fs.writeFile(guardMdPath, markdownGuard(guardReport), "utf8");
  await fs.writeFile(trendJsonPath, `${JSON.stringify(trendReport, null, 2)}\n`, "utf8");
  await fs.writeFile(trendMdPath, markdownTrend(trendReport), "utf8");
  console.log(`perf guard: ${guardReport.status} (${checks.length - failures.length}/${checks.length} checks passed)`);
  console.log(`wrote ${guardJsonPath}`);
  console.log(`wrote ${guardMdPath}`);
  console.log(`perf trend: ${trendReport.status} (${trendReport.regressions.length} regression watch item(s), ${trendReport.improvements.length} improvement(s))`);
  console.log(`wrote ${trendJsonPath}`);
  console.log(`wrote ${trendMdPath}`);
  if (failures.length) {
    for (const failure of failures.slice(0, 20)) {
      console.error(`FAIL ${failure.name}: ${failure.actual} > ${failure.budget}`);
    }
    process.exitCode = 1;
  } else if (trendReport.regressions.length && failOnTrendRegression()) {
    for (const regression of trendReport.regressions.slice(0, 20)) {
      console.error(
        `TREND ${regression.name}: ${regression.actual} ms vs historical median ${regression.previousMedian} ms`
      );
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
