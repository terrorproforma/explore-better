import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const benchmarkJsonPath = path.join(artifactsDir, "perf-benchmark-latest.json");
const benchmarkMdPath = path.join(artifactsDir, "perf-benchmark-latest.md");
const stressBenchmarkJsonPath = path.join(artifactsDir, "perf-100k-benchmark-latest.json");
const stressBenchmarkMdPath = path.join(artifactsDir, "perf-100k-benchmark-latest.md");
const stressJsonPath = path.join(artifactsDir, "perf-100k-latest.json");
const stressMdPath = path.join(artifactsDir, "perf-100k-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function numberOption(name, fallback) {
  const envName = name.replace(/^--/, "EB_PERF_100K_").replace(/-/g, "_").toUpperCase();
  const value = Number(optionValue(name, process.env[envName] || fallback));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function budgetDefaults() {
  return {
    coldListWallMs: numberOption("--cold-list-wall-ms", 30000),
    warmListWallMs: numberOption("--warm-list-wall-ms", 22000),
    warmListApiMs: numberOption("--warm-list-api-ms", 18000),
    warmListScannedRows: numberOption("--warm-list-scanned-rows", 5),
    broadFilterWallMs: numberOption("--broad-filter-wall-ms", 2000),
    narrowFilterWallMs: numberOption("--narrow-filter-wall-ms", 2000),
    apiSearchWallMs: numberOption("--api-search-wall-ms", 30000),
    indexBuildWallMs: numberOption("--index-build-wall-ms", 45000),
    indexSearchWallMs: numberOption("--index-search-wall-ms", 3000),
    indexSearchScannedRows: numberOption("--index-search-scanned-rows", 5),
    backgroundBuildWallMs: numberOption("--background-build-wall-ms", 60000),
    backgroundSearchWallMs: numberOption("--background-search-wall-ms", 3000),
    backgroundSearchScannedRows: numberOption("--background-search-scanned-rows", 5)
  };
}

function runProcess(file, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: workspace,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
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

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

async function restoreOptionalFile(filePath, content) {
  if (!content) return;
  await fs.writeFile(filePath, content);
}

function rounded(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10) / 10 : null;
}

function assertBudget(checks, name, actual, budget, detail = "") {
  const numeric = Number(actual);
  checks.push({
    name,
    status: Number.isFinite(numeric) && numeric <= budget ? "pass" : "fail",
    actual: rounded(numeric),
    budget,
    detail
  });
}

function assertMinimum(checks, name, actual, minimum, detail = "") {
  const numeric = Number(actual);
  checks.push({
    name,
    status: Number.isFinite(numeric) && numeric >= minimum ? "pass" : "fail",
    actual: rounded(numeric),
    budget: `>= ${minimum}`,
    detail
  });
}

function evaluateRun(run, budgets) {
  const checks = [];
  assertMinimum(checks, "100k listed entries", run.cold?.result?.returned, 100000, run.path);
  assertBudget(checks, "100k cold list wall", run.cold?.wallMs, budgets.coldListWallMs, run.path);
  assertBudget(checks, "100k warm list wall", run.warm?.wallMs, budgets.warmListWallMs, run.path);
  assertBudget(checks, "100k warm list API", run.warm?.result?.totalMs, budgets.warmListApiMs, run.path);
  assertBudget(
    checks,
    "100k warm list scanned",
    run.warm?.result?.scanned,
    budgets.warmListScannedRows,
    run.path
  );
  assertMinimum(
    checks,
    "100k warm list cache hit",
    run.warm?.result?.cache?.hit === true ? 1 : 0,
    1,
    run.path
  );
  assertBudget(checks, "100k broad pane filter", run.filterBroad?.wallMs, budgets.broadFilterWallMs, run.path);
  assertBudget(checks, "100k narrow pane filter", run.filterNarrow?.wallMs, budgets.narrowFilterWallMs, run.path);
  assertBudget(checks, "100k recursive API search", run.apiSearch?.wallMs, budgets.apiSearchWallMs, run.path);
  assertBudget(checks, "100k folder index build", run.indexBuild?.wallMs, budgets.indexBuildWallMs, run.path);
  assertBudget(checks, "100k folder index search", run.indexSearch?.wallMs, budgets.indexSearchWallMs, run.path);
  assertBudget(
    checks,
    "100k folder index search scanned",
    run.indexSearch?.result?.timing?.scanned,
    budgets.indexSearchScannedRows,
    run.path
  );
  assertMinimum(
    checks,
    "100k folder index search cache hit",
    run.indexSearch?.result?.timing?.storeCacheHits,
    1,
    run.path
  );
  assertMinimum(checks, "100k folder index search returned", run.indexSearch?.result?.results?.length || 0, 1, run.path);
  assertBudget(
    checks,
    "100k background index build",
    run.backgroundIndex?.buildWallMs,
    budgets.backgroundBuildWallMs,
    run.path
  );
  assertBudget(
    checks,
    "100k background index search",
    run.backgroundIndex?.search?.wallMs,
    budgets.backgroundSearchWallMs,
    run.path
  );
  assertBudget(
    checks,
    "100k background index search scanned",
    run.backgroundIndex?.search?.result?.timing?.scanned,
    budgets.backgroundSearchScannedRows,
    run.path
  );
  assertMinimum(
    checks,
    "100k background index search cache hit",
    run.backgroundIndex?.search?.result?.timing?.storeCacheHits,
    1,
    run.path
  );
  assertMinimum(
    checks,
    "100k background index search returned",
    run.backgroundIndex?.search?.result?.returned,
    1,
    run.path
  );
  return checks;
}

function markdownReport(report) {
  const rows = report.checks
    .map((check) => `| ${check.status} | ${check.name} | ${check.actual ?? ""} | ${check.budget} |`)
    .join("\n");
  return `# Explore Better 100k Stress Verification

Generated: ${report.generatedAt}

Status: ${report.status}

Fixture: \`${report.run?.path || ""}\`

Benchmark artifact: \`${stressBenchmarkJsonPath}\`

| Status | Check | Actual | Budget |
| --- | --- | ---: | ---: |
${rows}

Budgets can be tuned with \`EB_PERF_100K_*\` environment variables or matching CLI flags.
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const previousBenchmarkJson = await readOptionalFile(benchmarkJsonPath);
  const previousBenchmarkMd = await readOptionalFile(benchmarkMdPath);
  const count = Number(optionValue("--count", process.env.EB_PERF_100K_COUNT || "100000"));
  if (!Number.isInteger(count) || count < 100000) {
    throw new Error("100k verifier requires --count >= 100000.");
  }
  const port = optionValue("--port", process.env.PORT || "49341");
  const fixture = optionValue("--fixture", process.env.EB_PERF_100K_FIXTURE || "");
  const budgets = budgetDefaults();
  const args = [
    "scripts/perf-benchmark.mjs",
    `--counts=${count}`,
    "--media-counts=",
    "--content-counts=",
    `--port=${port}`
  ];
  if (fixture) {
    args.push(`--fixture=${fixture}`);
  }
  const result = await runProcess(process.execPath, args);
  if (result.stdout.trim()) {
    console.log(result.stdout.trim());
  }
  if (result.stderr.trim()) {
    console.error(result.stderr.trim());
  }
  if (result.code !== 0) {
    await restoreOptionalFile(benchmarkJsonPath, previousBenchmarkJson);
    await restoreOptionalFile(benchmarkMdPath, previousBenchmarkMd);
    throw new Error(`100k benchmark failed with exit code ${result.code}.`);
  }
  const benchmark = JSON.parse(await fs.readFile(benchmarkJsonPath, "utf8"));
  await fs.copyFile(benchmarkJsonPath, stressBenchmarkJsonPath);
  await fs.copyFile(benchmarkMdPath, stressBenchmarkMdPath).catch(() => {});
  await restoreOptionalFile(benchmarkJsonPath, previousBenchmarkJson);
  await restoreOptionalFile(benchmarkMdPath, previousBenchmarkMd);
  const run = (benchmark.runs || []).find((item) => Number(item.count) === count);
  if (!run) {
    throw new Error(`Benchmark did not include ${count} file run.`);
  }
  const checks = evaluateRun(run, budgets);
  const failures = checks.filter((check) => check.status === "fail");
  const report = {
    generatedAt: new Date().toISOString(),
    status: failures.length ? "fail" : "pass",
    count,
    benchmark: stressBenchmarkJsonPath,
    budgets,
    run,
    checks,
    failures
  };
  await fs.writeFile(stressJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(stressMdPath, markdownReport(report), "utf8");
  console.log(`perf 100k: ${report.status} (${checks.length - failures.length}/${checks.length} checks passed)`);
  console.log(`wrote ${stressJsonPath}`);
  console.log(`wrote ${stressMdPath}`);
  if (failures.length) {
    for (const failure of failures) {
      console.error(`FAIL ${failure.name}: ${failure.actual} > ${failure.budget}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
