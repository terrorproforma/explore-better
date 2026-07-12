import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const latestJsonPath = path.join(artifactsDir, "goal-stress-audit-latest.json");
const latestMdPath = path.join(artifactsDir, "goal-stress-audit-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

const maxAgeHours = Math.max(
  1,
  Math.min(Number(optionValue("--max-age-hours", process.env.EB_GOAL_AUDIT_MAX_AGE_HOURS || 72)), 24 * 14)
);
const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

function statusRank(status) {
  return status === "fail" ? 3 : status === "warn" ? 2 : 1;
}

function worstStatus(items) {
  return items.reduce((worst, item) => (statusRank(item.status) > statusRank(worst) ? item.status : worst), "pass");
}

function short(value, max = 420) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function artifactPath(name) {
  return path.join(artifactsDir, name);
}

async function pathExists(itemPath) {
  try {
    await fs.access(itemPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

function generatedAgeMs(data, stat) {
  const generatedAt = Date.parse(data?.generatedAt || "");
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Date.now() - Number(stat.mtimeMs || 0);
}

function formatAge(ms) {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function pass(detail, extra = {}) {
  return { status: "pass", detail, ...extra };
}

function warn(detail, extra = {}) {
  return { status: "warn", detail, ...extra };
}

function fail(detail, extra = {}) {
  return { status: "fail", detail, ...extra };
}

function requiredScripts(names) {
  return names.map((name) => ({
    type: "script",
    name,
    check(pkg) {
      return pkg.scripts?.[name] ? pass(pkg.scripts[name]) : fail(`Missing package script ${name}.`);
    }
  }));
}

function artifact(name, label, validate, options = {}) {
  return {
    type: "artifact",
    name,
    label,
    options,
    async check() {
      const filePath = artifactPath(name);
      let stat = null;
      try {
        stat = await fs.stat(filePath);
      } catch {
        return fail(`Missing ${name}. Run ${options.command || "the matching verifier"}.`, { path: filePath });
      }
      let data = null;
      try {
        data = await readJson(filePath);
      } catch (error) {
        return fail(`${name} is not readable JSON: ${error.message}`, { path: filePath });
      }
      const ageMs = generatedAgeMs(data, stat);
      if (options.fresh !== false && ageMs > maxAgeMs) {
        return fail(`${name} is stale: ${formatAge(ageMs)} old, max ${maxAgeHours}h.`, { path: filePath, ageMs });
      }
      const result = await validate(data, filePath);
      return {
        ...result,
        path: filePath,
        generatedAt: data?.generatedAt || null,
        ageMs,
        detail: `${result.detail}${result.detail ? " " : ""}(${formatAge(ageMs)} old)`
      };
    }
  };
}

function allReportsHaveNoIssues(data) {
  const reports = Array.isArray(data.reports) ? data.reports : [];
  return reports.length > 0 && reports.every((report) => Number(report.issueCount || 0) === 0 && !(report.issues || []).length);
}

function allHeaderReportsClean(data) {
  const reports = Array.isArray(data.reports) ? data.reports : [];
  return (
    reports.length > 0 &&
    reports.every((report) => {
      const directIssues = report.issues || [];
      const headerIssues = report.header?.issues || [];
      const workbenchIssues = report.workbench?.issues || [];
      const speedIssues = report.speed?.issues || [];
      return !directIssues.length && !headerIssues.length && !workbenchIssues.length && !speedIssues.length;
    })
  );
}

function countFailedChecks(data) {
  return Array.isArray(data.checks) ? data.checks.filter((check) => check.status === "fail").length : 0;
}

function countWarnChecks(data) {
  return Array.isArray(data.checks) ? data.checks.filter((check) => check.status === "warn").length : 0;
}

function operationRecoveryOk(operation) {
  return (
    operation?.status === "failed" &&
    operation?.recovery?.interrupted === true &&
    operation?.recovery?.partialCompletionUnverified === true &&
    (operation?.recovery?.remainingCount === 0 || operation?.recovery?.canRetryRemaining === true)
  );
}

const coverageAreas = [
  {
    id: "performance",
    label: "Performance benchmark harness",
    requirement: "1k/10k/100k folders, cold/warm loads, startup latency, thumbnail/media cache, search/filter latency, content indexing.",
    evidence: [
      ...requiredScripts([
        "perf:bench",
        "perf:bench:100k",
        "perf:guard",
        "verify:speed-health",
        "verify:startup-latency",
        "verify:perf-100k",
        "verify:windows-baseline",
        "verify:mixed-load",
        "verify:listing-cache-ui",
        "verify:listing-cache-eviction-ui",
        "verify:listing-prefetch-ui",
        "verify:rapid-navigation-ui",
        "verify:folder-index-corruption",
        "verify:folder-index-token-search",
        "verify:server-listing-cache",
        "verify:operation-listing-cache",
        "verify:network-loopback",
        "verify:background-index-token-search",
        "verify:large-folder-100k-ui",
        "verify:size-analysis-perf",
        "verify:size-analysis-cancel"
      ]),
      artifact("perf-guard-latest.json", "Perf guard", (data) =>
        data.status === "pass" && countFailedChecks(data) === 0
          ? pass(`${data.checks?.length || 0} guard checks passed.`)
          : fail(`Perf guard status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`)
      ),
      artifact("speed-health-latest.json", "Consolidated speed health", (data) => {
        if (data.failOnTrendRegression !== true) {
          return fail("Speed health did not run with strict trend-regression enforcement.");
        }
        if (data.status !== "pass" || data.summary?.warn > 0 || data.summary?.fail > 0) {
          return fail(`${data.summary?.fail || 0} speed health failure(s), ${data.summary?.warn || 0} warning(s).`);
        }
        const hot = Array.isArray(data.hotMetrics) ? data.hotMetrics[0] : null;
        const requiredAreas = [
          "startup",
          "native-baseline",
          "guard",
          "stress-100k",
          "mixed-load",
          "browser-cache",
          "thumbnail-cache",
          "large-folder-ui",
          "size-analysis",
          "network",
          "background-index",
          "speed-ui",
          "search-ui"
        ];
        const areas = new Set((data.areas || []).map((area) => area.area));
        const missing = requiredAreas.filter((area) => !areas.has(area));
        return !missing.length
          ? pass(
              `${data.metrics?.length || 0} speed metric(s), ${data.summary?.warn || 0} warning(s); hottest ${hot?.name || "n/a"} at ${hot?.percentOfBudget ?? "?"}% budget.`
            )
          : fail(`Speed health is missing required area(s): ${missing.join(", ")}.`);
      }),
      artifact("startup-latency-latest.json", "Startup latency gate", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Startup latency status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const rows = data.browser?.snapshot?.renderedRows || 0;
        if (rows < 1 || (data.firstList?.returned || 0) < 1) {
          return fail("Startup latency did not prove a first fixture list and visible browser rows.");
        }
        return pass(
          `roots ${data.server?.roots?.sinceStartMs} ms, list ${data.firstList?.wallMs} ms, DOM ${data.browser?.domContentLoadedWallMs} ms, rows ${data.browser?.firstRowsWallMs} ms.`
        );
      }),
      artifact("perf-100k-latest.json", "100k stress gate", (data) => {
        if (data.status !== "pass" || Number(data.count || data.run?.count || 0) < 100000) {
          return fail("100k stress gate did not prove a passing 100000 item run.");
        }
        const indexScanned = (data.checks || []).find((check) => check.name === "100k folder index search scanned");
        if (!indexScanned || indexScanned.status !== "pass") {
          return fail(`100k stress gate did not prove bounded active-index scanning: ${indexScanned?.actual ?? "missing"}.`);
        }
        const warmScanned = (data.checks || []).find((check) => check.name === "100k warm list scanned");
        if (!warmScanned || warmScanned.status !== "pass") {
          return fail(`100k stress gate did not prove bounded warm-list scanning: ${warmScanned?.actual ?? "missing"}.`);
        }
        const warmCache = (data.checks || []).find((check) => check.name === "100k warm list cache hit");
        if (!warmCache || warmCache.status !== "pass") {
          return fail("100k stress gate did not prove a server warm-list cache hit.");
        }
        return pass(
          `100k gate passed; cold ${data.run?.cold?.wallMs || "?"} ms, warm ${data.run?.warm?.wallMs || "?"} ms, warm scanned ${warmScanned.actual} row(s), active-index scanned ${indexScanned.actual} row(s).`
        );
      }),
      artifact("windows-baseline-latest.json", "Windows-native baseline gate", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Windows baseline status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const cases = Array.isArray(data.cases) ? data.cases : [];
        const largest = cases.reduce((best, item) => (Number(item.count || 0) > Number(best?.count || 0) ? item : best), null);
        const ok =
          Number(largest?.count || 0) >= 100000 &&
          cases.every(
            (item) =>
              Number(item.native?.second?.scanned || 0) >= Number(item.count || 0) &&
              item.app?.warm?.cache?.hit === true &&
              Number(item.app?.warm?.scanned ?? Infinity) === 0 &&
              item.app?.warmWindow?.cache?.hit === true &&
              Number(item.app?.warmWindow?.scanned ?? Infinity) === 0 &&
              Number(item.app?.warmWindow?.returned || 0) ===
                Math.min(Number(item.budgets?.windowLimit || data.budgets?.windowLimit || 200), Number(item.count || 0)) &&
              Number(item.app?.warmWindow?.totalEntries || 0) === Number(item.count || 0) &&
              Number(item.app?.indexSearch?.returned || 0) === 1 &&
              Number(item.app?.indexSearch?.scanned ?? Infinity) <=
                Number(item.budgets?.searchScannedBudget || data.budgets?.searchScannedBudget || 2)
          );
        return ok
          ? pass(
              `Windows-native enumeration baseline covered up to ${largest.count} entries; native warm scanned ${largest.native?.second?.scanned} item(s), app warm scanned ${largest.app?.warm?.scanned}, windowed warm list returned ${largest.app?.warmWindow?.returned}/${largest.app?.warmWindow?.totalEntries} in ${largest.app?.warmWindow?.wallMs} ms, and indexed search scanned ${largest.app?.indexSearch?.scanned}.`
            )
          : fail("Windows baseline did not prove warm app listing avoids full native enumeration and indexed search stays candidate-bounded.");
      }),
      artifact("size-analysis-perf-latest.json", "Size Analyzer speed gate", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Size Analyzer perf status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const herd = data.inFlightHerd || {};
        const herdCount = Number(herd.count || 0);
        const herdJoined = Number(herd.joined || 0);
        const ok =
          Number(data.fixture?.count || 0) >= 10000 &&
          Number(herd.origins || 0) === 1 &&
          herdJoined >= Math.max(1, herdCount - 1) &&
          data.snapshots?.warm?.cache?.hit === true &&
          data.snapshots?.afterMutation?.cache?.hit !== true &&
          data.snapshots?.postMutationWarm?.cache?.hit === true &&
          data.isolation?.analysis?.cache?.hit !== true &&
          Number(data.isolation?.indexBuild?.count || 0) >= Number(data.isolation?.expectedForegroundRows || 1) &&
          Number(data.isolation?.operationCount || 0) >= 24 &&
          Number(data.isolation?.failures?.length || 0) === 0 &&
          Number(data.isolation?.foreground?.list?.minReturned || 0) >= Number(data.isolation?.expectedForegroundRows || 1) &&
          Number(data.isolation?.foreground?.nameSearch?.minReturned || 0) >= 1 &&
          Number(data.isolation?.foreground?.nameSearch?.maxScanned ?? Infinity) <= Number(data.budgets?.isolationSearchScannedBudget || 5) &&
          Number(data.createOperation?.cacheInvalidation?.sizeAnalysisInvalidation?.invalidated || 0) >= 1;
        return ok
          ? pass(
              `Analyzer scanned ${data.fixture.count} files cold in ${data.snapshots?.cold?.wallMs} ms, coalesced ${herdJoined}/${herdCount} cold duplicate request(s), kept foreground list/search p95 at ${data.isolation?.foreground?.list?.p95Ms}/${data.isolation?.foreground?.nameSearch?.p95Ms} ms while scanning, repeated from cache in ${data.snapshots?.warm?.wallMs} ms, and invalidated after mutation.`
            )
          : fail(
              "Size Analyzer perf did not prove 10k cold scan, in-flight cold coalescing, foreground responsiveness while scanning, warm cache, operation invalidation, and post-mutation rewarm."
            );
      }),
      artifact("size-analysis-cancel-latest.json", "Size Analyzer cancellation gate", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Size Analyzer cancellation status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const restarted = Number(data.follower?.cache?.restartedAfterAbortedInFlight || 0);
        const ok =
          Number(data.fixture?.count || 0) >= 10000 &&
          data.origin?.aborted === true &&
          data.follower?.ok === true &&
          data.follower?.cache?.source === "filesystem" &&
          restarted >= 1 &&
          data.warm?.cache?.hit === true &&
          Number(data.foreground?.failures?.length || 0) === 0 &&
          Number(data.foreground?.list?.minReturned || 0) >= Number(data.foreground?.expectedListRows || 1) &&
          Number(data.foreground?.roots?.minReturned || 0) >= 1;
        return ok
          ? pass(
              `Analyzer aborted an origin request in ${data.origin?.wallMs} ms, restarted ${restarted} duplicate request(s), completed the recovered scan in ${data.follower?.wallMs} ms, and kept list/roots p95 at ${data.foreground?.list?.p95Ms}/${data.foreground?.roots?.p95Ms} ms.`
            )
          : fail("Size Analyzer cancellation did not prove aborted-origin recovery, foreground responsiveness, and warm cache after recovery.");
      }),
      artifact("server-listing-cache-latest.json", "Server listing cache invalidation", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Server listing-cache smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        if (data.warm?.cache?.hit !== true || Number(data.warm?.scanned ?? Infinity) !== 0 || data.warm?.cache?.stampValidated !== true) {
          return fail(
            `Warm server listing was not a stamp-validated zero-scan cache hit: hit=${data.warm?.cache?.hit}, scanned=${data.warm?.scanned ?? "missing"}, stamp=${data.warm?.cache?.stampValidated}.`
          );
        }
        if (data.afterChange?.cache?.hit === true || Number(data.afterChange?.scanned ?? 0) < Number(data.fixture?.count || 0) + 1) {
          return fail("Server listing cache did not miss and rescan after the watched folder changed.");
        }
        if (data.postChangeWarm?.cache?.hit !== true || Number(data.postChangeWarm?.scanned ?? Infinity) !== 0 || data.postChangeWarm?.cache?.stampValidated !== true) {
          return fail("Server listing cache did not re-warm with stamp validation after the watched folder changed.");
        }
        if (data.richWarm?.cache?.hit !== true || Number(data.richWarm?.scanned ?? Infinity) !== 0 || data.richWarm?.cache?.stampValidated !== true) {
          return fail(
            `Rich metadata listing was not a stamp-validated zero-scan cache hit: hit=${data.richWarm?.cache?.hit}, scanned=${data.richWarm?.scanned ?? "missing"}, stamp=${data.richWarm?.cache?.stampValidated}.`
          );
        }
        if (data.richCold?.dimensionProbe?.dimensions?.width !== 1 || data.richCold?.dimensionProbe?.dimensions?.height !== 1) {
          return fail("Rich metadata listing did not prove image dimensions were preserved in cached rows.");
        }
        if (data.richAfterChange?.cache?.hit === true || Number(data.richAfterChange?.scanned ?? 0) < Number(data.fixture?.totalCount || data.fixture?.count || 0) + 1) {
          return fail("Rich metadata listing cache did not miss and rescan after the watched folder changed.");
        }
        if (
          data.richPostChangeWarm?.cache?.hit !== true ||
          Number(data.richPostChangeWarm?.scanned ?? Infinity) !== 0 ||
          data.richPostChangeWarm?.cache?.stampValidated !== true
        ) {
          return fail("Rich metadata listing cache did not re-warm with stamp validation after the watched folder changed.");
        }
        const herd = data.inFlightHerd || {};
        const herdCount = Number(herd.count || 0);
        const herdJoined = Number(herd.joined || 0);
        const joinedScanned = Array.isArray(herd.joinedScanned) ? herd.joinedScanned : [];
        if (Number(herd.origins || 0) !== 1 || herdJoined < Math.max(1, herdCount - 1) || !joinedScanned.every((value) => Number(value || 0) === 0)) {
          return fail(
            `Server listing cache did not prove in-flight cold request coalescing: origins=${herd.origins ?? "missing"}, joined=${herd.joined ?? "missing"}/${herd.count ?? "missing"}, joinedScanned=${joinedScanned.join(",")}.`
          );
        }
        return pass(
          `${data.fixture?.totalCount || data.fixture?.count || 0} file folder coalesced ${herdJoined}/${herdCount} cold duplicate request(s), warmed in ${data.warm?.wallMs || "?"} ms, and rich warmed in ${data.richWarm?.wallMs || "?"} ms with stamp-validated zero scanned rows; invalidated and re-warmed after a write.`
        );
      }),
      artifact("operation-listing-cache-latest.json", "App operation listing-cache invalidation", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Operation listing-cache smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const requiredTypes = ["create", "copy", "move", "rename", "delete", "sync"];
        const missingInvalidation = requiredTypes.filter((type) => Number(data.operations?.[type]?.invalidated || 0) < 1);
        if (missingInvalidation.length) {
          return fail(`Operation listing-cache smoke missed active invalidation for: ${missingInvalidation.join(", ")}.`);
        }
        const snapshots = data.snapshots || {};
        const immediateMisses = [
          snapshots.targetAfterCreate?.cache?.hit !== true && (snapshots.targetAfterCreate?.names || []).includes("created.txt"),
          snapshots.targetAfterCopy?.cache?.hit !== true && (snapshots.targetAfterCopy?.names || []).includes("copy-me.txt"),
          snapshots.moveSourceAfter?.cache?.hit !== true && !(snapshots.moveSourceAfter?.names || []).includes("move-me.txt"),
          snapshots.moveTargetAfter?.cache?.hit !== true && (snapshots.moveTargetAfter?.names || []).includes("move-me.txt"),
          snapshots.renameAfter?.cache?.hit !== true &&
            (snapshots.renameAfter?.names || []).includes("after.txt") &&
            !(snapshots.renameAfter?.names || []).includes("before.txt"),
          snapshots.deleteAfter?.cache?.hit !== true && !(snapshots.deleteAfter?.names || []).includes("delete-me.txt"),
          snapshots.syncRightAfter?.cache?.hit !== true && (snapshots.syncRightAfter?.names || []).includes("fresh.txt")
        ];
        if (!immediateMisses.every(Boolean)) {
          return fail("Operation listing-cache smoke did not prove immediate post-mutation misses with correct folder rows.");
        }
        return pass("Create, copy, move, rename, delete, and sync all actively invalidated warmed listing caches before the next pane refresh.");
      }),
      artifact("listing-cache-ui-latest.json", "Frontend listing cache revisit", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Listing-cache UI smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        if (data.cold?.source !== "Filesystem") {
          return fail(`Cold pane source was ${data.cold?.source || "missing"}, expected Filesystem.`);
        }
        if (data.warm?.source !== "Memory cache") {
          return fail(`Warm pane source was ${data.warm?.source || "missing"}, expected Memory cache.`);
        }
        if (!/cached/i.test(data.warm?.statusText || "")) {
          return fail(`Warm revisit did not expose cached status text: ${data.warm?.statusText || "missing"}.`);
        }
        if (!Number.isFinite(Number(data.warm?.liveLoadMs))) {
          return fail("Warm revisit did not expose live Speed load timing.");
        }
        return pass(
          `Browser revisit rendered ${data.warm?.paneItems || "?"} item(s) from ${data.warm.source}; live load ${data.warm.liveLoadMs} ms.`
        );
      }),
      artifact("listing-cache-eviction-ui-latest.json", "Frontend listing cache eviction", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Listing-cache eviction UI smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        if (data.snapshots?.oldAfterChurn?.source !== "Filesystem") {
          return fail(`Old folder source after churn was ${data.snapshots?.oldAfterChurn?.source || "missing"}, expected Filesystem.`);
        }
        if (data.snapshots?.recentAfterChurn?.source !== "Memory cache") {
          return fail(`Recent folder source after churn was ${data.snapshots?.recentAfterChurn?.source || "missing"}, expected Memory cache.`);
        }
        if (Number(data.requests?.oldRequestDelta || 0) < 1) {
          return fail(`Old folder did not issue a fresh /api/list after churn; delta ${data.requests?.oldRequestDelta ?? "missing"}.`);
        }
        if (Number(data.requests?.recentRequestDelta || 0) !== 0) {
          return fail(`Recent folder issued /api/list despite warm cache; delta ${data.requests?.recentRequestDelta ?? "missing"}.`);
        }
        if (Number(data.churn?.elapsedMs || Infinity) >= Number(data.cache?.ttlMs || 8000)) {
          return fail(`Cache churn exceeded TTL, so eviction proof is ambiguous: ${data.churn?.elapsedMs || "missing"} ms.`);
        }
        return pass(
          `${data.churn?.folderCount || "?"} folder churn pruned old entries while recent entry stayed warm; cache size ${data.cache?.afterChurn?.size ?? "n/a"}/${data.cache?.maxEntries || "?"}.`
        );
      }),
      artifact("listing-prefetch-ui-latest.json", "Predictive listing prefetch", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Listing-prefetch UI smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        if (Number(data.prefetch?.startedWhileHeld || 0) < 1) {
          return fail("Hover/focus prefetch did not start any target listing requests.");
        }
        if (Number(data.prefetch?.startedWhileHeld || 0) > Number(data.prefetch?.maxActive || 2)) {
          return fail(`Prefetch started ${data.prefetch?.startedWhileHeld} held requests, above max active ${data.prefetch?.maxActive || 2}.`);
        }
        if (data.snapshots?.afterOpen?.source !== "Memory cache") {
          return fail(`Prefetched folder opened from ${data.snapshots?.afterOpen?.source || "missing"}, expected Memory cache.`);
        }
        if (Number(data.prefetch?.targetOpenRequestDelta || 0) !== 0) {
          return fail(`Opening the prefetched folder issued ${data.prefetch?.targetOpenRequestDelta} extra /api/list request(s).`);
        }
        return pass(
          `Hover prefetch warmed the target with ${data.prefetch.startedWhileHeld}/${data.prefetch.maxActive} held request(s); open reused cache with delta ${data.prefetch.targetOpenRequestDelta}.`
        );
      }),
      artifact("rapid-navigation-ui-latest.json", "Rapid navigation stale-load guard", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Rapid-navigation UI smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        if (Number(data.routeStats?.delayedSlowRequests || 0) < 1 || Number(data.routeStats?.continuedSlowRequests || 0) < 1) {
          return fail("Rapid-navigation smoke did not exercise a delayed old list response.");
        }
        const finalState = data.navigation?.afterSlowResponse || {};
        const race = finalState.race || {};
        if (Number(race.abortCalls || 0) < 1 || Number(race.suppressedAbortCalls || 0) < 1) {
          return fail("Rapid-navigation smoke did not prove the app attempted to abort the stale load.");
        }
        if (finalState.path !== data.fastFolder || finalState.finalVisible !== true || finalState.staleVisible !== false) {
          return fail("Delayed stale response overwrote the final pane state or left stale rows visible.");
        }
        if (!data.navigation?.slowResponse?.ok) {
          return fail(`Delayed slow response did not return cleanly: ${data.navigation?.slowResponse?.error || "missing"}.`);
        }
        const quickOk =
          data.navigation?.quickSearch?.rows?.length === 1 &&
          /1 match/.test(data.navigation?.quickSearch?.countText || "") &&
          String(data.navigation?.quickSearch?.rows?.[0]?.text || "").includes("final-target.txt");
        if (!quickOk) {
          return fail("Quick Search was not responsive after rapid navigation.");
        }
        return pass(
          `Delayed old response returned after ${race.suppressedAbortCalls} abort attempt(s); final folder stayed rendered with ${finalState.rowCount} row(s).`
        );
      }),
      artifact("mixed-load-latest.json", "Mixed foreground load", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Mixed-load smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        if (Number(data.workload?.operationCount || 0) < 32) {
          return fail(`Mixed-load smoke only ran ${data.workload?.operationCount || 0} operation(s).`);
        }
        if (Number(data.operations?.list?.minReturned || 0) < Number(data.fixture?.fileCount || 1)) {
          return fail("Mixed-load list requests did not return the complete fixture.");
        }
        if (
          Number(data.operations?.nameSearch?.minReturned || 0) < 1 ||
          Number(data.operations?.contentSearch?.minReturned || 0) < 1 ||
          Number(data.operations?.raw?.minBytes || 0) <= 0
        ) {
          return fail("Mixed-load smoke did not prove name search, content search, and raw file fetch correctness.");
        }
        return pass(
          `${data.workload?.operationCount || 0} mixed foreground operation(s) passed; list p95=${data.operations?.list?.p95Ms} ms, search p95=${data.operations?.nameSearch?.p95Ms} ms, raw p95=${data.operations?.raw?.p95Ms} ms.`
        );
      }),
      artifact("perf-benchmark-latest.json", "Media/content benchmark", (data) => {
        const mediaCount = Array.isArray(data.mediaRuns) ? data.mediaRuns.length : 0;
        const contentCount = Array.isArray(data.contentRuns) ? data.contentRuns.length : 0;
        const networkCount = Array.isArray(data.networkRuns) ? data.networkRuns.length : 0;
        if (!mediaCount || !contentCount) {
          return fail(`Expected media and content benchmark runs; got media=${mediaCount}, content=${contentCount}.`);
        }
        if (!networkCount) {
          return pass("Media/content benchmarks passed; dedicated network-loopback artifact covers default UNC timing.");
        }
        return pass(`Media=${mediaCount}, content=${contentCount}, network=${networkCount}.`);
      }),
      artifact("network-loopback-latest.json", "Loopback UNC network timing", (data) => {
        if (data.status === "pass" && data.checks?.diagnostics?.result?.isNetwork === true) {
          return pass(
            `${data.mode} ${data.networkPath}: cold ${data.checks?.cold?.wallMs} ms, warm ${data.checks?.warm?.wallMs} ms, index ${data.checks?.indexSearch?.wallMs} ms.`
          );
        }
        if (data.status === "unavailable") {
          return warn(data.detail || "No loopback SMB path was available.");
        }
        return fail(data.detail || "Loopback UNC network timing failed.");
      }),
      artifact("folder-index-corruption-latest.json", "Active folder index corruption resilience", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Folder-index corruption status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const corruptJsonOk = Boolean(data.corruptJson?.quarantinedPath) && data.corruptJson?.searchSafe === true;
        const badSchemaOk = Boolean(data.badSchema?.quarantinedPath) && data.badSchema?.error === "invalid-folder-index-schema";
        const finalOk = Number(data.final?.count || 0) >= 2 && Number(data.final?.searchReturned || 0) >= 1;
        return corruptJsonOk && badSchemaOk && finalOk
          ? pass("Corrupt active-folder index JSON and bad schemas were quarantined; rebuild restored folder search.")
          : fail("Folder-index corruption smoke did not prove quarantine, safe search response, and rebuild recovery.");
      }),
      artifact("folder-index-token-search-latest.json", "Active folder token-index search acceleration", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Folder token-search smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        if (Number(data.build?.index?.tokenIndex?.tokens || 0) < Number(data.fixture?.count || 0)) {
          return fail(`Active token index exposed ${data.build?.index?.tokenIndex?.tokens || 0} token(s) for ${data.fixture?.count || 0} file(s).`);
        }
        if (!data.search?.hit || data.search?.timing?.tokenNarrowed !== true) {
          return fail("Active folder token search did not return the target through a narrowed token index.");
        }
        if (Number(data.search?.timing?.scanned || Infinity) > Number(data.budgets?.scannedBudget || 5)) {
          return fail(`Active folder token search scanned ${data.search?.timing?.scanned || "missing"} candidate(s), above budget.`);
        }
        if (Number(data.repeatSearch?.timing?.storeCacheHits || 0) < 1) {
          return fail("Active folder token search did not prove a repeat warm index-cache hit.");
        }
        return pass(
          `${data.fixture?.count || 0} file active index searched ${data.search?.timing?.scanned || 0} candidate(s), then repeated in ${data.repeatSearch?.wallMs || "?"} ms from cache.`
        );
      }),
      artifact("large-folder-100k-ui-latest.json", "100k browser virtualization", (data) => {
        const reports = Array.isArray(data.reports) ? data.reports : [];
        const clean = reports.every(
          (report) =>
            report?.listingRequests?.[0]?.isWindow === true &&
            Number(report?.windowFirst?.renderedRows || 0) > 0 &&
            Number(report?.windowFirst?.renderedRows || 0) <= 220 &&
            report?.windowFirst?.virtualized === false &&
            (report?.listingRequests || []).some((request) => request.isWindow === false) &&
            report?.virtualInitial?.virtualized === true &&
            Number(report?.virtualInitial?.renderedRows || 0) < 250 &&
            !(report?.header?.issues || []).length &&
            !(report?.consoleErrors || []).length &&
            !(report?.pageErrors || []).length
        );
        const responsive = reports.every((report) => !Number.isFinite(Number(report?.filterMs)) || Number(report.filterMs) < 2500);
        return Number(data.count || 0) >= 100000 && reports.length > 0 && clean && responsive
          ? pass(`${data.count} item browser fixture painted a bounded first window, then stayed virtualized with bounded rows across ${reports.length} viewport(s).`)
          : fail("100k browser UI did not prove window-first paint, clean headers, no page errors, bounded virtualization, and responsive filter.")
      })
    ]
  },
  {
    id: "background-index",
    label: "Background index and instant search",
    requirement: "Filename, metadata, labels, notes, restart persistence, and optional text-content indexing.",
    evidence: [
      ...requiredScripts([
        "verify:background-index",
        "verify:background-index-freshness",
        "verify:background-index-watch",
        "verify:background-index-operation",
        "verify:scripting-mutation-cache",
        "verify:background-index-restart",
        "verify:background-index-isolation",
        "verify:background-index-concurrency",
        "verify:background-priority",
        "verify:background-index-cancel",
        "verify:background-index-corruption",
        "verify:background-index-token-search",
        "verify:speed-index-ui",
        "verify:search-background-ui"
      ]),
      artifact("background-index-latest.json", "Background index warm search", (data) =>
        data.nameSearch?.returned > 0 && data.labelSearch?.returned > 0 && data.contentSearch?.returned > 0
          ? pass(
              `name=${data.nameSearch.returned}, label=${data.labelSearch.returned}, content=${data.contentSearch.returned}, build=${data.root?.search?.buildMs} ms.`
            )
          : fail("Background index did not prove name, label, and content warm-cache hits.")
      ),
      artifact("background-index-restart-latest.json", "Background index restart persistence", (data) => {
        const beforeOk = data.before?.nameTiming?.returned > 0 && data.before?.labelTiming?.returned > 0 && data.before?.contentTiming?.returned > 0;
        const afterOk = data.after?.nameTiming?.returned > 0 && data.after?.labelTiming?.returned > 0 && data.after?.contentTiming?.returned > 0;
        return beforeOk && afterOk
          ? pass("Warm index survived backend restart with name, label, and content hits.")
          : fail("Warm background index did not prove before/after restart search hits.");
      }),
      artifact("background-index-isolation-latest.json", "Background index foreground isolation", (data) => {
        const clean = data.status === "pass" && countFailedChecks(data) === 0;
        const overlap = Number(data.runningSamples || 0) >= 1;
        const foregroundOk =
          Number(data.latency?.list?.p95Ms || Infinity) <= Number(data.budgets?.listP95Ms || 0) &&
          Number(data.latency?.search?.p95Ms || Infinity) <= Number(data.budgets?.searchP95Ms || 0);
        const backgroundOk = Number(data.backgroundSearch?.returned || 0) >= 1;
        return clean && overlap && foregroundOk && backgroundOk
          ? pass(
              `Foreground list/search stayed within budget during background indexing; list p95=${data.latency.list.p95Ms} ms, search p95=${data.latency.search.p95Ms} ms.`
            )
          : fail("Background isolation smoke did not prove foreground list/search budget while indexing and background completion.");
      }),
      artifact("background-index-concurrency-latest.json", "Background index restarted search herd", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Background concurrency status is ${data.status || "missing"} with ${countFailedChecks(data)} failure(s).`);
        }
        const herd = data.herd || {};
        const herdCount = Number(herd.count || 0);
        const herdJoined = Number(herd.joined || 0);
        const ok =
          Number(data.fixture?.count || 0) >= 20000 &&
          Number(herd.origins || 0) === 1 &&
          herdJoined >= Math.max(1, herdCount - 1) &&
          data.warm?.source === "background-search-store-cache" &&
          data.warm?.hit === true;
        return ok
          ? pass(
              `${data.fixture.count} file background index served a restarted ${herdCount} request herd with ${herdJoined} in-flight join(s), then warmed in ${data.warm.wallMs} ms.`
            )
          : fail("Background concurrency smoke did not prove one restarted cold store read, joined duplicate searches, and a warm cache hit.");
      }),
      artifact("background-priority-latest.json", "Background index priority lane", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Background priority status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const foreground = Number(data.foreground?.concurrency || 0);
        const backgroundList = Number(data.background?.listConcurrency?.max || 0);
        const backgroundContent = Number(data.background?.contentConcurrency?.max || 0);
        const searchHit = Number(data.background?.searchReturned || 0) >= 1;
        return foreground > backgroundList && backgroundList >= 1 && backgroundContent >= 1 && searchHit
          ? pass(`Foreground lane used ${foreground} workers; background list/content lanes used ${backgroundList}/${backgroundContent} and still searched warm content.`)
          : fail("Background priority smoke did not prove lower-priority background indexing with warm search correctness.");
      }),
      artifact("background-index-cancel-latest.json", "Background index cancellation and restart", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Background cancel status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const canceled = data.canceled?.status === "canceled" && data.canceled?.searchPresentAfterCancel === false;
        const restarted =
          Number(data.restart?.searchCount || 0) >= Number(data.fixture?.expectedFiles || 1) &&
          Number(data.restart?.contentIndexed || 0) >= Number(data.fixture?.expectedFiles || 1) &&
          Number(data.restart?.searchReturned || 0) >= 1;
        return canceled && restarted
          ? pass(`Canceled ${data.canceled.jobId}, left no complete cache, then rebuilt ${data.restart.searchCount} searchable item(s).`)
          : fail("Background cancel smoke did not prove cancellation without partial complete cache and successful restart.");
      }),
      artifact("background-index-freshness-latest.json", "Background index stale-cache self-heal", (data) => {
        const checksOk = data.status === "pass" && countFailedChecks(data) === 0;
        const autoRebuild = data.autoRebuild || data.staleOverview?.autoRebuild || data.staleOverview?.freshness?.autoRebuild;
        const staleOk = data.staleOverview?.freshness?.stale === true && (autoRebuild?.scheduled === true || autoRebuild?.active === true);
        const rebuildOk =
          data.rebuiltOverview?.freshness?.status === "fresh" &&
          data.rebuiltSearch?.freshness?.stale === false &&
          data.rebuiltSearch?.hit === true;
        return checksOk && staleOk && rebuildOk
          ? pass("Warm cache reported external mutation as stale, auto-started repair, then found the new file.")
          : fail("Background freshness smoke did not prove stale detection, auto-rebuild, and recovery.");
      }),
      artifact("background-index-watch-latest.json", "Background index proactive watcher repair", (data) => {
        const checksOk = data.status === "pass" && countFailedChecks(data) === 0;
        const watcherOk =
          data.initialOverview?.watcher?.available === true &&
          Number(data.initialOverview?.watcher?.watchedFolders || 0) >= 1 &&
          data.rebuiltOverview?.watcher?.lastAutoRebuild?.source === "watch" &&
          Number(data.rebuiltOverview?.watcher?.eventCount || 0) >= 1;
        const recoveryOk =
          data.rebuiltOverview?.freshness?.status === "fresh" &&
          data.rebuiltSearch?.freshness?.stale === false &&
          data.rebuiltSearch?.hit === true;
        const burstOk =
          Number(data.burstSearch?.hits || 0) === Number(data.paths?.burstPaths?.length || 0) &&
          Number(data.paths?.burstPaths?.length || 0) >= 8;
        const burstChecksOk = (data.checks || []).some(
          (item) => item.id === "watch-burst-debounced" && item.status === "pass"
        );
        const deleteRenameOk =
          (data.checks || []).some((item) => item.id === "watch-delete-rename-removes-stale-hit" && item.status === "pass") &&
          data.deleteRenameSearch?.renamedPresent === true &&
          data.deleteRenameSearch?.deletedPresent === false &&
          data.deleteRenameSearch?.oldNamePresent === false &&
          Number(data.deleteRenameSearch?.hits || 0) === Number(data.paths?.burstPaths?.length || 0) - 1;
        const restartOk =
          data.restartOverview?.watcher?.lastAutoRebuild?.source === "watch" &&
          data.restartSearch?.hit === true &&
          Number(data.restartJobs?.length || 0) <= 1 &&
          (data.checks || []).some((item) => item.id === "watch-restart-auto-rebuild-started" && item.status === "pass") &&
          (data.checks || []).some((item) => item.id === "watch-restart-search-finds-new-file" && item.status === "pass");
        return checksOk && watcherOk && recoveryOk && burstOk && burstChecksOk && deleteRenameOk && restartOk
          ? pass(
              "Background root watcher observed changes, debounced create/delete/rename bursts, removed stale search hits, survived backend restart, and found all current files."
            )
          : fail(
              "Background watch smoke did not prove proactive watcher rebuild, create/delete/rename burst debounce, stale-hit removal, restart watcher recovery, and search recovery."
            );
      }),
      artifact("background-index-operation-latest.json", "Background index app-operation repair", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Background operation-invalidation status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const invalidation = data.createOperation?.result?.backgroundIndexInvalidation;
        const affectedRoot = (invalidation?.roots || []).find((root) => root.id === data.rootId);
        const operationOk =
          data.initialOverview?.watcher?.enabled === false &&
          Number(invalidation?.affected || 0) >= 1 &&
          affectedRoot?.autoRebuild?.source === "operation" &&
          (affectedRoot?.autoRebuild?.scheduled === true || affectedRoot?.autoRebuild?.active === true);
        const rebuildOk =
          data.rebuiltOverview?.lastAutoRebuildReason === "operation:create-file" &&
          data.rebuiltOverview?.freshness?.status === "fresh" &&
          data.rebuiltSearch?.freshness?.stale === false &&
          data.rebuiltSearch?.hit === true;
        return operationOk && rebuildOk
          ? pass("App-owned file creation proactively queued a background-index rebuild without relying on folder watchers, then found the new file.")
          : fail("Background operation-invalidation smoke did not prove watcher-disabled app mutation scheduling and search recovery.");
      }),
      artifact("scripting-mutation-cache-latest.json", "Background index script-mutation repair", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Scripting mutation-cache status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const invalidation = data.scriptResult?.backgroundIndexInvalidation;
        const affectedRoot = (invalidation?.roots || []).find((root) => root.id === data.rootId);
        const scriptOk =
          data.initialOverview?.watcher?.enabled === false &&
          Number(invalidation?.affected || 0) >= 1 &&
          affectedRoot?.autoRebuild?.source === "script" &&
          (affectedRoot?.autoRebuild?.scheduled === true || affectedRoot?.autoRebuild?.active === true);
        const rebuildOk =
          data.rebuiltOverview?.lastAutoRebuildReason === "script" &&
          data.rebuiltOverview?.freshness?.status === "fresh" &&
          data.rebuiltSearch?.freshness?.stale === false &&
          data.rebuiltSearch?.hit === true;
        return scriptOk && rebuildOk
          ? pass("Trusted script mutation proactively queued a background-index rebuild without relying on folder watchers, then found the written file.")
          : fail("Scripting mutation-cache smoke did not prove watcher-disabled script mutation scheduling and search recovery.");
      }),
      artifact("background-index-corruption-latest.json", "Background index store corruption resilience", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Background-index corruption status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const searchStoreOk =
          data.searchStoreCorruption?.reason === "search-store-corrupt" &&
          Boolean(data.searchStoreCorruption?.quarantinedPath) &&
          Number(data.rebuilt?.searchReturned || 0) >= 1 &&
          Number(data.rebuilt?.contentIndexed || 0) >= 1;
        const manifestOk =
          data.manifestCorruption?.searchIndexed === true &&
          data.manifestCorruption?.hit === true &&
          Boolean(data.manifestCorruption?.quarantinedPath);
        const finalOk = Number(data.final?.count || 0) >= 4 && Number(data.final?.contentIndexed || 0) >= 1;
        return searchStoreOk && manifestOk && finalOk
          ? pass("Corrupt search store was quarantined and rebuilt; corrupt manifest was quarantined without breaking warm search.")
          : fail("Background index corruption smoke did not prove search-store quarantine/rebuild and manifest corruption tolerance.");
      }),
      artifact("background-index-token-search-latest.json", "Background token-index search acceleration", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Background token-search smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        if (Number(data.root?.search?.tokenIndex?.tokens || 0) < Number(data.fixture?.count || 0)) {
          return fail(`Token index exposed ${data.root?.search?.tokenIndex?.tokens || 0} token(s) for ${data.fixture?.count || 0} file(s).`);
        }
        if (!data.search?.hit || Number(data.search?.timing?.tokenNarrowedStores || 0) < 1) {
          return fail("Token search did not return the target through a narrowed token-index store.");
        }
        if (Number(data.search?.timing?.storeCacheHits || 0) < 1 || Number(data.repeatSearch?.timing?.storeCacheHits || 0) < 1) {
          return fail("Token search did not prove warm background store-cache hits.");
        }
        if (Number(data.search?.timing?.scanned || Infinity) > Number(data.budgets?.scannedBudget || 5)) {
          return fail(`Token search scanned ${data.search?.timing?.scanned || "missing"} candidate(s), above budget.`);
        }
        return pass(
          `${data.fixture?.count || 0} file token index searched ${data.search?.timing?.scanned || 0} candidate(s) from warm store cache in ${data.search?.wallMs || "?"} ms.`
        );
      }),
      artifact("speed-index-ui-latest.json", "Speed Index browser workflow", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Speed Index UI smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const indexed = Number.parseInt(data.folderIndex?.metrics?.indexed?.value || "0", 10);
        const folderHit = (data.folderSearch?.resultButtons || []).some(
          (item) => item.path === data.fixturePaths?.labelledPath || String(item.text || "").includes("labelled-speed-target.txt")
        );
        const backgroundHit = (data.backgroundSearch?.resultButtons || []).some(
          (item) =>
            item.path === data.fixturePaths?.contentPath ||
            (String(item.text || "").includes("content-background-only.md") && /obsidian invoice/i.test(item.text || ""))
        );
        const watcherVisible =
          (data.background?.backgroundRows || []).some((row) => /Watching \d+ folder/i.test(row.text || "")) &&
          Number.parseInt(data.background?.metrics?.["bg-watched"]?.value || "0", 10) >= 1;
        const autoRebuildVisible =
          (data.backgroundAutoRebuild?.backgroundRows || data.backgroundStale?.backgroundRows || []).some((row) =>
            /Stale:|Auto rebuild|Running/i.test(row.text || "")
          ) || Number.parseInt(data.backgroundAutoRebuild?.staleMetric || "0", 10) >= 1;
        const autoRebuildHit = (data.backgroundRecoveredSearch?.resultButtons || []).some(
          (item) => item.path === data.fixturePaths?.stalePath && /velvet compass/i.test(String(item.text || ""))
        );
        const endpoints = data.endpointCounts || {};
        const endpointsOk =
          endpoints["/api/index/build"] >= 1 &&
          endpoints["/api/index/search"] >= 1 &&
          endpoints["/api/background-indexes/start"] >= 1 &&
          endpoints["/api/background-indexes/search"] >= 1;
        const layoutOk = !Array.isArray(data.layout?.issues) || data.layout.issues.length === 0;
        return indexed >= 3 && folderHit && backgroundHit && watcherVisible && autoRebuildVisible && autoRebuildHit && endpointsOk && layoutOk
          ? pass(`Speed UI built ${indexed} item folder index, found label notes, found background text content, and auto-recovered stale cache.`)
          : fail("Speed Index UI smoke did not prove build/search/background/self-heal workflow and clean layout.");
      }),
      artifact("search-background-ui-latest.json", "Search dialog warm-cache browser workflow", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Search background UI smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const contentHit = (data.contentSearch?.rows || []).some(
          (item) => item.path === data.fixturePaths?.contentPath && /obsidian invoice/i.test(item.text || "")
        );
        const scopedOut = !(data.contentSearch?.rows || []).some((item) => item.path === data.fixturePaths?.otherContentPath);
        const labelHit = (data.labelSearch?.rows || []).some(
          (item) => item.path === data.fixturePaths?.labelledPath && /aurora ledger/i.test(item.text || "")
        );
        const endpoints = data.endpointCounts || {};
        const endpointsOk = endpoints["/api/background-indexes/search"] >= 2 && !endpoints["/api/search"];
        const layoutOk = !Array.isArray(data.layout?.issues) || data.layout.issues.length === 0;
        return contentHit && scopedOut && labelHit && endpointsOk && layoutOk
          ? pass("Search dialog used the warm background cache for scoped content and label-note results.")
          : fail("Search dialog warm-cache smoke did not prove scoped content, label-note hits, endpoint use, and clean layout.");
      })
    ]
  },
  {
    id: "native-shell",
    label: "Deeper native shell coverage",
    requirement: "This PC, drives, network, Recycle Bin, libraries, MTP/phones, ZIPs, shortcuts, symlinks, and special folders.",
    evidence: [
      ...requiredScripts([
        "verify:shell",
        "verify:shell-namespace",
        "verify:shell-devices",
        "verify:native-shell-readiness",
        "verify:shell-verbs",
        "verify:windows-recycle",
        "verify:zip-browse",
        "verify:filesystem-objects",
        "verify:real-paths",
        "verify:network-loopback"
      ]),
      artifact("shell-locations-latest.json", "Navigator shell locations", (data) => {
        const required = ["thisPc", "libraries", "network", "recycleBin"];
        const actual = new Set(data.virtualFolders || []);
        const missing = required.filter((id) => !actual.has(id));
        return missing.length ? fail(`Missing shell virtual folders: ${missing.join(", ")}.`) : pass(`Virtual folders: ${required.join(", ")}.`);
      }),
      artifact("shell-namespace-latest.json", "Shell namespace enumeration", (data) =>
        data.namespaces?.thisPc?.available === true && data.namespaces?.network?.warmCached === true
          ? pass(`This PC ${data.namespaces.thisPc.count}, Network warm cached in ${data.namespaces.network.warmElapsedMs} ms.`)
          : fail("Shell namespace artifact does not prove This PC and warm-cached Network enumeration.")
      ),
      artifact("shell-devices-latest.json", "Portable shell device safety", (data) => {
        if (data.status === "fail" || data.summary?.fail > 0) {
          return fail(`${data.summary?.fail || 1} shell device failure(s).`);
        }
        const hardwareSnapshot = data.hardwareSnapshot || {};
        const hardwareElapsedMs = Number(hardwareSnapshot.elapsedMs ?? Infinity);
        const hardwareSnapshotUnavailable = data.platform === "win32" && hardwareSnapshot.available !== true;
        if (data.platform === "win32" && hardwareElapsedMs >= 6500) {
          return fail(
            `Shell-device verifier did not keep the Windows hardware snapshot bounded: available=${hardwareSnapshot.available}, elapsed=${hardwareSnapshot.elapsedMs ?? "missing"} ms.`
          );
        }
        if (data.requireDevice === true && hardwareSnapshotUnavailable) {
          return fail(
            `Strict shell-device proof requested an attached device, but the Windows hardware snapshot was unavailable: ${hardwareSnapshot.error || hardwareSnapshot.reason || "not available"}.`
          );
        }
        if (
          data.invariants?.nonFilesystemNeverPaneOpen !== true ||
          data.invariants?.portableDevicesMarkedShellDevices !== true ||
          data.thisPc?.warmCached !== true
        ) {
          return fail("Shell-device verifier did not prove pane safety, portable-device classification, and This PC warm-cache behavior.");
        }
        const simulated = data.simulatedDevices || {};
        const simulatedItems = Array.isArray(simulated.sample) ? simulated.sample : [];
        const simulatedSampleSafe =
          simulatedItems.length >= 1 &&
          simulatedItems.every((item) => item.isPortableDevice && item.isShellDevice && item.shellOnly && !item.isFileSystem && !item.canOpenPane);
        const simulatedProbe = data.simulatedProbe || {};
        const simulatedDryRunOk = simulatedProbe.dryRunOpen?.ok === true && simulatedProbe.dryRunOpen?.dryRun === true;
        const simulatedBrowseOk =
          simulatedProbe.browse?.count >= 1 && simulatedProbe.browse?.shellSafe === true && Number(simulatedProbe.browse?.elapsedMs || 0) < 6500;
        if (!simulated.count || !simulatedSampleSafe || !simulatedDryRunOk || !simulatedBrowseOk) {
          return fail(
            "Shell-device verifier did not prove deterministic MTP/portable-device safety with simulated shell-only browse and dry-run handoff."
          );
        }
        if (hardwareSnapshotUnavailable) {
          return warn(
            `Shell-only pane safety, simulated portable-device browse, and warm-cache checks passed, but the Windows hardware snapshot was unavailable: ${hardwareSnapshot.error || hardwareSnapshot.reason || "not available"}. ${data.attachmentGuide?.strictCommand || "Run verify:shell-devices with --require-device."}`
          );
        }
        if (!data.devices?.count) {
          return warn(
            `Shell-only pane safety, simulated portable-device browse, and warm-cache checks passed, but no phone/MTP/camera device was attached. ${data.attachmentGuide?.strictCommand || "Run verify:shell-devices with --require-device."}`
          );
        }
        if (!data.probe || (!data.probe.dryRunOpen && !data.probe.browse)) {
          return fail(`${data.devices.count} shell device candidate(s) found, but no dry-run or browse probe was captured.`);
        }
        return pass(`${data.devices.count} attached shell device candidate(s) and ${simulated.count} simulated portable device candidate(s) validated.`);
      }),
      artifact("native-shell-readiness-latest.json", "Native shell readiness manifest", (data) => {
        if (data.summary?.fail > 0 || data.status === "fail") {
          return fail(`${data.summary?.fail || 1} native shell readiness failure(s).`);
        }
        if (data.localReady !== true) {
          return fail("Native shell readiness manifest does not mark local shell coverage as ready.");
        }
        const checklist = Array.isArray(data.readinessChecklist) ? data.readinessChecklist : [];
        const requiredLocal = [
          "local-shell-locations",
          "local-shell-namespace",
          "local-hardware-discovery-snapshot",
          "local-portable-device-safety",
          "local-shell-verbs",
          "local-recycle-bin",
          "local-zip-browse",
          "local-filesystem-objects",
          "local-real-paths",
          "local-network-loopback"
        ];
        const missing = requiredLocal.filter((id) => !checklist.some((item) => item.id === id && item.status === "pass"));
        if (missing.length) {
          return fail(`Native shell readiness manifest is missing local pass gate(s): ${missing.join(", ")}.`);
        }
        const hardwareCommands = Array.isArray(data.commands?.hardware) ? data.commands.hardware : [];
        if (!hardwareCommands.includes("npm run verify:shell-devices -- --require-device")) {
          return fail("Native shell readiness manifest does not include the attached-device strict proof command.");
        }
        const blockers = Array.isArray(data.hardwareBlockers) ? data.hardwareBlockers : [];
        return data.hardwareReady === true
          ? pass("Native shell readiness manifest says local and attached-device shell gates are complete.")
          : pass(`Local native shell gates are complete; ${blockers.length} attached-device blocker(s) are listed explicitly.`);
      }),
      artifact("shell-verbs-latest.json", "Native shell verbs", (data) =>
        data.verbs?.available === true && data.verbs?.count > 0
          ? pass(`${data.verbs.count} shell verbs enumerated.`)
          : fail("Shell verbs were not enumerated for the fixture file.")
      ),
      artifact("windows-recycle-latest.json", "Windows Recycle Bin restore", (data) =>
        data.operation?.status === "completed" && data.dryRun?.matched >= 1
          ? pass("Recycle item listed, dry-run matched, and restore operation completed.")
          : fail("Windows Recycle Bin restore path is not proven.")
      ),
      artifact("zip-browse-latest.json", "ZIP virtual browsing", (data) =>
        data.root?.count >= 1 && data.nested?.count >= 1 && data.deep?.count >= 1
          ? pass(`ZIP root/nested/deep counts ${data.root.count}/${data.nested.count}/${data.deep.count}.`)
          : fail("ZIP virtual browsing did not prove nested archive traversal.")
      ),
      artifact("filesystem-objects-latest.json", "Shortcuts and filesystem objects", (data) =>
        data.index?.returned >= 1 && data.background?.returned >= 1 && data.undo?.removedCreatedObjects && data.undo?.sourcesIntact
          ? pass("Link metadata indexed in live/background caches and created objects were undone.")
          : fail("Filesystem object coverage did not prove indexing and undo safety.")
      ),
      artifact("real-paths-latest.json", "Real path diagnostics", (data) =>
        data.status === "pass" && Array.isArray(data.results) && data.results.some((result) => result.status === "pass")
          ? pass(`${data.passed || data.results.filter((result) => result.status === "pass").length}/${data.total || data.results.length} real path target(s) passed.`)
          : fail("Real-path verifier did not discover or diagnose targets.")
      ),
      artifact("network-loopback-latest.json", "Network share listing/index", (data) =>
        data.status === "pass" && data.checks?.diagnostics?.result?.kind === "unc" && data.checks?.indexSearch?.result?.indexed === true
          ? pass(`UNC share listed ${data.checks?.warm?.result?.returned || 0} item(s) and indexed successfully.`)
          : warn(data.detail || "No loopback UNC network share evidence is available.")
      )
    ]
  },
  {
    id: "operations",
    label: "Bulletproof operations and conflict preview",
    requirement: "Restart-resumable copy/move/delete/sync, audit rows, undo, retry lineage, and exact conflict plans.",
    evidence: [
      ...requiredScripts([
        "verify:operations",
        "verify:operation-preview-scale",
        "verify:power-tools-ui",
        "verify:operation-journal",
        "verify:operation-journal-concurrency",
        "verify:operation-journal-scale",
        "verify:operation-journal-retention",
        "verify:operation-journal-corruption",
        "verify:operation-cancel",
        "verify:operation-sync-cancel",
        "verify:operation-pause-resume",
        "verify:ops-recovery-ui",
        "verify:state-lock"
      ]),
      artifact("operation-preview-latest.json", "Conflict preview", (data) => {
        const transferOk = data.transfer?.actionCounts?.rename >= 1 && data.transfer?.actionCounts?.copy >= 1;
        const syncOk =
          data.sync?.actionCounts?.copy >= 1 &&
          data.sync?.actionCounts?.overwrite >= 1 &&
          data.sync?.actionCounts?.["mirror-delete"] >= 1 &&
          data.sync?.actionCounts?.risky >= 1;
        const digestOk =
          /^[a-f0-9]{64}$/.test(data.transfer?.planDigest || "") &&
          /^[a-f0-9]{64}$/.test(data.sync?.planDigest || "") &&
          /preview changed/i.test(data.transfer?.staleApplyRejected || "") &&
          /preview changed/i.test(data.sync?.staleApplyRejected || "") &&
          data.transfer?.freshDigestApply?.operationStatus === "completed" &&
          data.transfer?.freshDigestApply?.copied === true &&
          data.sync?.freshDigestApply?.operationStatus === "completed" &&
          data.sync?.freshDigestApply?.copied === true;
        return transferOk && syncOk && digestOk && data.unsafePathRejected
          ? pass("Transfer/sync preview proved rename, overwrite, mirror-delete, risky, unsafe-path, stale-apply rejection, and fresh-digest apply cases.")
          : fail("Operation preview did not prove exact conflict/safety cases, including stale rejection and fresh digest apply.");
      }),
      artifact("operation-preview-scale-latest.json", "Conflict preview scale", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Operation preview scale status is ${data.status || "missing"} with ${countFailedChecks(data)} failure(s).`);
        }
        const transferExpected = data.transfer?.expectedActionCounts || {};
        const transferActual = data.transfer?.actionCounts || {};
        const syncExpected = data.sync?.expectedActionCounts || {};
        const syncActual = data.sync?.actionCounts || {};
        const actionCountsMatch = (actual, expected) =>
          Object.entries(expected).every(([key, value]) => Number(actual?.[key] || 0) === Number(value));
        const transferOk =
          Number(data.transfer?.count || 0) >= 500 &&
          actionCountsMatch(transferActual, transferExpected) &&
          data.transfer?.nonMutating === true &&
          /^[a-f0-9]{64}$/.test(data.transfer?.planDigest || "") &&
          Number(data.transfer?.wallMs || Infinity) <= Number(data.budgets?.transferBudgetMs || 6000);
        const syncOk =
          Number(data.sync?.count || 0) >= 1000 &&
          actionCountsMatch(syncActual, syncExpected) &&
          data.sync?.nonMutating === true &&
          /^[a-f0-9]{64}$/.test(data.sync?.planDigest || "") &&
          Number(data.sync?.wallMs || Infinity) <= Number(data.budgets?.syncBudgetMs || 7000);
        return transferOk && syncOk
          ? pass(
              `${data.transfer.count} transfer and ${data.sync.count} sync preview item(s) counted exactly without disk mutation; ${data.transfer.wallMs}/${data.sync.wallMs} ms.`
            )
          : fail("Operation preview scale did not prove exact large transfer/sync conflict counts, bounded latency, digests, and non-mutation.");
      }),
      artifact("power-tools-ui-latest.json", "Browser power tools and sync preview", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Power-tools UI smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const flatOk = /items/.test(data.flat?.summary || "") && data.flat?.hasFlatTarget === true;
        const duplicateOk = /1 groups/.test(data.duplicates?.summary || "") && data.duplicates?.hasBothDuplicates === true;
        const compareRows = data.compare?.compare?.statuses || [];
        const compareOk =
          compareRows.some((text) => String(text).includes("leftOnly")) &&
          compareRows.some((text) => String(text).includes("rightOnly")) &&
          compareRows.some((text) => String(text).includes("newerLeft"));
        const previewRows = data.compare?.preview?.rows || [];
        const previewOk =
          /planned/.test(data.compare?.preview?.summary || "") &&
          previewRows.some((text) => String(text).includes("copy")) &&
          previewRows.some((text) => String(text).includes("overwrite")) &&
          data.diskProof?.rightUpdateUnchanged === true &&
          data.diskProof?.leftOnlyNotCopied === true;
        if (!flatOk || !duplicateOk || !compareOk || !previewOk) {
          return fail("Power-tools UI smoke did not prove Flat, Dupes, Compare, and non-mutating sync preview together.");
        }
        return pass(
          `Flat ${data.flat.rowCount} rows; duplicate ${data.duplicates.summary}; ${data.compare.preview.summary}; no sync mutation.`
        );
      }),
      artifact("operation-journal-latest.json", "Operation journal integrity", (data) =>
        data.counts?.operations >= 10 &&
        data.counts?.completed >= 9 &&
        data.counts?.undoable >= 5 &&
        data.counts?.retryLinked >= 1
          ? pass(
              `${data.counts.operations} ops, ${data.counts.completed} completed, ${data.counts.undoable} undoable, ${data.counts.retryLinked} retry-linked.`
            )
          : fail("Operation journal did not prove completion, undo, and retry lineage coverage.")
      ),
      artifact("operation-journal-concurrency-latest.json", "Operation journal concurrent writes", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Operation journal concurrency status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const count = Number(data.burst?.count || 0);
        const apiCount = Number(data.journal?.apiCount || 0);
        const persistedCount = Number(data.journal?.persistedCount || 0);
        const missingApi = Array.isArray(data.journal?.missingApiIds) ? data.journal.missingApiIds : [];
        const missingPersisted = Array.isArray(data.journal?.missingPersistedIds) ? data.journal.missingPersistedIds : [];
        const operations = Array.isArray(data.operations) ? data.operations : [];
        const allCompleted = operations.length >= count && operations.every((operation) => operation.status === "completed" && operation.progress?.phase === "Completed");
        const cacheInvalidated = operations.every((operation) => Number(operation.result?.cacheInvalidation?.invalidated || operation.cacheInvalidation?.invalidated || 0) >= 1);
        return count >= 24 &&
          data.burst?.uniqueIds === count &&
          data.disk?.createdCount === count &&
          apiCount >= count &&
          persistedCount >= count &&
          data.journal?.persistedMatchesApi === true &&
          missingApi.length === 0 &&
          missingPersisted.length === 0 &&
          allCompleted &&
          cacheInvalidated
          ? pass(`${count} concurrent create-file operation(s) completed with ${apiCount} API row(s), ${persistedCount} persisted row(s), and no lost journal entries.`)
          : fail("Operation journal concurrency did not prove no lost rows, persisted/API parity, completed progress, disk files, and cache invalidation.");
      }),
      artifact("operation-journal-scale-latest.json", "Operation journal scale bound", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Operation journal scale status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        if (Number(data.seeded?.count || 0) <= 100) {
          return fail(`Operation journal scale only seeded ${data.seeded?.count || 0} row(s).`);
        }
        if (Number(data.afterStartup?.count || 0) !== 100 || Number(data.afterCreate?.count || 0) !== 100) {
          return fail(`Journal bound was not preserved: startup=${data.afterStartup?.count || 0}, afterCreate=${data.afterCreate?.count || 0}.`);
        }
        const recovered = Array.isArray(data.afterStartup?.recovered) ? data.afterStartup.recovered : [];
        if (recovered.length < 3 || recovered.some((item) => item.status !== "failed" || item.interrupted !== true)) {
          return fail("Operation journal scale did not prove interrupted rows recover after startup.");
        }
        if (!data.afterCreate?.createdOperationId || data.afterCreate.firstId !== data.afterCreate.createdOperationId) {
          return fail("Operation journal scale did not prove a fresh operation can enter the saturated journal first.");
        }
        return pass(
          `${data.seeded.count} seeded row(s) trimmed to 100; ${recovered.length} interrupted row(s) recovered; fresh operation ${data.afterCreate.createdOperationId} stayed first.`
        );
      }),
      artifact("operation-journal-retention-latest.json", "Operation journal actionable retention", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Operation journal retention status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const seeded = Number(data.seeded?.count || 0);
        const bounded = Number(data.afterStartup?.count || 0) === 100 && Number(data.afterRetry?.count || 0) === 100;
        const protectedKept = data.afterStartup?.protectedPresent === true && data.afterRetry?.protectedPresent === true;
        const retryOk = data.retry?.status === "completed" && data.retry?.retryOf === "old-recoverable-copy";
        const linked = data.afterRetry?.protectedLastRetryOperationId === data.retry?.operationId;
        return seeded > 100 && bounded && protectedKept && retryOk && linked
          ? pass(`Old recoverable row survived ${seeded} seeded row(s), retried as ${data.retry.operationId}, and journal stayed bounded.`)
          : fail("Operation journal retention smoke did not prove bounded history with preserved actionable recovery.");
      }),
      artifact("operation-journal-corruption-latest.json", "Operation journal corruption resilience", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Operation journal corruption status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const badStatus = data.afterStartup?.badStatus || {};
        const runningCopy = data.afterStartup?.runningCopy || {};
        const browserClean =
          Array.isArray(data.browser?.pageErrors) &&
          data.browser.pageErrors.length === 0 &&
          Array.isArray(data.browser?.consoleErrors) &&
          data.browser.consoleErrors.length === 0 &&
          (data.browser?.rows || []).some((row) => row.hasRetryRemaining === true && row.hasDetails === true);
        const createOk = data.afterCreate?.firstId && data.afterCreate.firstId === data.afterCreate.createdOperationId;
        return badStatus.status === "failed" && runningCopy.result?.recovery?.interrupted === true && browserClean && createOk
          ? pass(`Malformed rows sanitized; interrupted row recovered; browser Ops dialog clean; fresh operation ${data.afterCreate.createdOperationId} recorded.`)
          : fail("Operation journal corruption smoke did not prove sanitization, recovery UI cleanliness, and continued writes.");
      }),
      artifact("operation-cancel-latest.json", "Live operation cancellation recovery", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Operation cancel status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const count = Number(data.fixture?.count || 0);
        const completed = Number(data.cancel?.completedCount || 0);
        const remaining = Number(data.cancel?.remainingCount || -1);
        const cancelOk =
          data.cancel?.finalStatus === "canceled" &&
          completed >= 1 &&
          remaining === count - completed &&
          Array.isArray(data.cancel?.targetNamesAfterCancel) &&
          data.cancel.targetNamesAfterCancel.length === completed;
        const retryOk =
          data.retry?.status === "completed" &&
          data.retry?.retryOf === data.cancel?.operationId &&
          Array.isArray(data.retry?.targetNamesAfterRetry) &&
          data.retry.targetNamesAfterRetry.length === count;
        return cancelOk && retryOk
          ? pass(`Canceled after ${completed}/${count} copied item(s), retried ${remaining} remaining item(s), and ended with exact targets.`)
          : fail("Operation cancel smoke did not prove no-duplicate remaining-work retry after live cancellation.");
      }),
      artifact("operation-sync-cancel-latest.json", "Live sync cancellation recovery", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Sync cancel status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const count = Number(data.fixture?.count || 0);
        const completed = Number(data.cancel?.completedCount || 0);
        const remaining = Number(data.cancel?.remainingCount || -1);
        const cancelOk =
          data.cancel?.finalStatus === "canceled" &&
          completed >= 1 &&
          remaining === count - completed &&
          Array.isArray(data.cancel?.rightNamesAfterCancel) &&
          data.cancel.rightNamesAfterCancel.length === completed;
        const retryOk =
          data.retry?.status === "completed" &&
          data.retry?.retryOf === data.cancel?.operationId &&
          Array.isArray(data.retry?.rightNamesAfterRetry) &&
          data.retry.rightNamesAfterRetry.length === count;
        return cancelOk && retryOk
          ? pass(`Canceled sync after ${completed}/${count} item(s), retried ${remaining} remaining item(s), and ended with exact right-folder contents.`)
          : fail("Sync cancel smoke did not prove no-duplicate remaining-work retry after live sync cancellation.");
      }),
      artifact("operation-pause-resume-latest.json", "Live operation pause/resume hold", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Operation pause/resume status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const count = Number(data.fixture?.count || 0);
        const completed = Number(data.pause?.completedBeforePause || 0);
        const held =
          completed >= 1 &&
          Array.isArray(data.pause?.targetNamesAtPause) &&
          Array.isArray(data.pause?.targetNamesWhilePaused) &&
          data.pause.targetNamesAtPause.length === completed &&
          data.pause.targetNamesWhilePaused.length === completed;
        const finished =
          data.operation?.finalStatus === "completed" &&
          Boolean(data.operation?.pausedAt) &&
          Boolean(data.operation?.resumedAt) &&
          Array.isArray(data.resume?.targetNamesAfterResume) &&
          data.resume.targetNamesAfterResume.length === count;
        return held && finished
          ? pass(`Paused after ${completed}/${count} copied item(s), held target count, then resumed to exact completion.`)
          : fail("Operation pause/resume smoke did not prove held progress and exact completion.");
      }),
      artifact("ops-recovery-ui-latest.json", "Ops recovery browser workflow", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Ops recovery UI smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const recoveredRows = (data.opsDialog?.rows || []).filter((row) => row.hasRecovery === true);
        const recoveredOk =
          recoveredRows.length >= 3 &&
          recoveredRows.every(
            (row) =>
              row.status === "failed" &&
              row.actions?.some((action) => /Details/.test(action.text || "")) &&
              row.actions?.some((action) => /Retry Remaining/.test(action.text || ""))
          );
        const detailsOk =
          data.details?.initial?.remainingRows?.length >= 1 &&
          data.details?.initial?.failedRows?.length >= 1 &&
          data.details?.afterClear?.remainingRows?.every((row) => row.selected === false) &&
          data.details?.afterSelectAll?.remainingRows?.every((row) => row.selected === true);
        const retryOk =
          data.retry?.operation?.status === "completed" &&
          data.retry?.operation?.retryOf === "running-copy" &&
          data.retry?.sourceAfterRetry?.recovery?.lastSelectedRetryOperationId === data.retry.operation.id &&
          data.retry?.copiedTargetStatuses?.every(Boolean);
        const layoutOk = !Array.isArray(data.layout?.issues) || data.layout.issues.length === 0;
        return recoveredOk && detailsOk && retryOk && layoutOk
          ? pass(`Ops UI showed ${recoveredRows.length} recoverable row(s), selection controls, and completed selected retry.`)
          : fail("Ops recovery UI did not prove visible recovery rows, details controls, selected retry, and clean layout.");
      }),
      artifact("state-lock-latest.json", "State lock resilience", (data) =>
        data.lockExit === 0 &&
        data.saved?.density === "spacious" &&
        Array.isArray(data.saved?.aliasNames) &&
        data.saved.aliasNames.includes("locktest") &&
        Number(data.writeWallMs || 0) >= Number(data.lockMs || 0)
          ? pass(`State retry survived ${data.lockMs} ms lock; write wall ${data.writeWallMs} ms.`)
          : fail("State lock resilience did not prove lock retry and persisted settings.")
      )
    ]
  },
  {
    id: "metadata-cache",
    label: "Thumbnail and metadata cache",
    requirement: "Async, cancellable, persistent media/link metadata cache that makes warm folders faster.",
    evidence: [
      ...requiredScripts([
        "perf:guard",
        "verify:filesystem-objects",
        "verify:thumbnail-cache-ui",
        "verify:metadata-cache-corruption",
        "verify:cache-maintenance",
        "verify:large-folder-ui"
      ]),
      artifact("perf-benchmark-latest.json", "Image metadata cache", (data) => {
        const media = Array.isArray(data.mediaRuns) ? data.mediaRuns[0] : null;
        const cold = media?.cold?.wallMs;
        const warm = media?.warm?.wallMs;
        const hits = media?.warm?.result?.dimensionsCache?.hits ?? media?.warm?.result?.dimensionsCacheHits;
        if (Number.isFinite(cold) && Number.isFinite(warm) && warm <= cold) {
          return pass(`Media cache warm ${warm} ms <= cold ${cold} ms${Number.isFinite(hits) ? `, hits=${hits}` : ""}.`);
        }
        return fail("Media metadata benchmark did not prove a warm-cache improvement.");
      }),
      artifact("filesystem-objects-latest.json", "Link metadata cache", (data) =>
        data.index?.returned >= 1 && data.background?.returned >= 1
          ? pass(`Link metadata returned live=${data.index.returned}, background=${data.background.returned}.`)
          : fail("Link metadata cache/index coverage is missing.")
      ),
      artifact("thumbnail-cache-ui-latest.json", "Browser thumbnail lazy/cache behavior", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Thumbnail-cache UI smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const count = Number(data.count || 0);
        const initialRaw = Number(data.tiles?.initialRaw?.uniquePaths || 0);
        const afterRaw = Number(data.tiles?.afterScrollRaw?.uniquePaths || 0);
        const initialTiles = Number(data.tiles?.initial?.renderedTiles || 0);
        const afterTiles = Number(data.tiles?.afterScroll?.renderedTiles || 0);
        const cacheOk =
          data.cache?.firstRaw?.status === 200 &&
          /immutable/i.test(data.cache?.firstRaw?.cacheControl || "") &&
          Boolean(data.cache?.firstRaw?.etag) &&
          data.cache?.conditionalRaw?.status === 304 &&
          data.cache?.rangeRaw?.status === 206 &&
          /^bytes 0-/.test(data.cache?.rangeRaw?.contentRange || "") &&
          data.cache?.suffixRangeRaw?.status === 206 &&
          data.cache?.invalidRangeRaw?.status === 416 &&
          Number(data.cache?.conditionalHerd?.count || 0) > 0 &&
          Number(data.cache?.conditionalHerd?.notModified || 0) === Number(data.cache?.conditionalHerd?.count || 0);
        const lazyOk =
          count > 0 &&
          data.tiles?.initial?.virtualized === true &&
          initialTiles > 0 &&
          initialTiles < count &&
          initialRaw > 0 &&
          initialRaw < count * 0.35 &&
          afterRaw > initialRaw &&
          afterRaw < count &&
          afterTiles > 0 &&
          afterTiles < count * 0.35;
        return cacheOk && lazyOk
          ? pass(
              `Browser tiles loaded ${initialRaw}/${count} thumbnail(s) initially, ${afterRaw} after scroll; raw cache returned 304 plus byte-range 206.`
            )
          : fail("Browser thumbnail smoke did not prove lazy bounded tile loads, cache-friendly raw responses, and byte-range streaming.");
      }),
      artifact("metadata-cache-corruption-latest.json", "Metadata cache corruption resilience", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Metadata-cache corruption status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const count = Number(data.count || 0);
        const poison = data.poisonedRepair?.dimensionsCache || {};
        const warm = data.warm?.dimensionsCache || {};
        const broken = data.brokenJsonRepair?.dimensionsCache || {};
        const repairedPoison = poison.repaired === true && Number(poison.invalidEntries || 0) >= 1 && Number(poison.pruned || 0) >= 1;
        const warmHits = Number(warm.hits || 0) === count && Number(warm.misses || 0) === 0 && Number(warm.updates || 0) === 0;
        const rebuiltBroken = broken.repaired === true && Number(broken.updates || 0) === count && Number(broken.entries || 0) === count;
        return count > 0 && repairedPoison && warmHits && rebuiltBroken
          ? pass(`Corrupt dimensions cache repaired, warm cache hit ${warm.hits}/${count}, broken JSON rebuilt cleanly.`)
          : fail("Metadata-cache corruption smoke did not prove poisoned-cache repair, warm hits, and broken-JSON rebuild.");
      }),
      artifact("cache-maintenance-latest.json", "Persistent cache maintenance", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Cache maintenance status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const dryEligible = Number(data.dryRun?.eligible || 0);
        const deleted = Number(data.apply?.deleted || 0);
        const afterEligible = Number(data.after?.eligible || 0);
        const activeKept = (data.checks || []).some((item) => item.id === "active-and-current-cache-preserved" && item.status === "pass");
        return dryEligible >= 1 && deleted >= dryEligible && afterEligible === 0 && activeKept
          ? pass(`Dry-run found ${dryEligible} stale cache artifact(s); apply removed ${deleted} and preserved active warm caches.`)
          : fail("Cache maintenance smoke did not prove dry-run safety, stale cleanup, and active-cache preservation.");
      })
    ]
  },
  {
    id: "admin-uac",
    label: "Admin and UAC flow",
    requirement: "Normal-user browsing for legacy known-folder paths plus graceful elevated helper plan for protected copy/move/delete remaining work.",
    evidence: [
      ...requiredScripts(["verify:elevation", "verify:elevation-ui", "verify:no-admin-access"]),
      artifact("no-admin-access-latest.json", "Normal-user legacy folder redirect", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`No-admin access smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const listingOk = data.listing?.path === data.expectedVideosPath && data.listing?.redirectedFrom === data.legacyVideosPath && !data.listing?.accessError;
        const analyzerOk = data.analysis?.path === data.expectedVideosPath && data.analysis?.redirectedFrom === data.legacyVideosPath && !data.analysis?.accessError;
        return listingOk && analyzerOk
          ? pass("Legacy My Videos path redirected for listing and Analyzer without running as administrator.")
          : fail("No-admin smoke did not prove listing and Analyzer redirects without access errors.");
      }),
      artifact("elevation-plan-latest.json", "Elevation helper planning", (data) =>
        data.dryRun?.itemCount >= 1 && data.prepared?.scriptPath && data.prepared?.manifestPath && data.prepared?.launcherPath
          ? pass(`Prepared ${data.prepared.type} helper package with manifest and launcher.`)
          : fail("Elevation planning did not produce a dry-run and helper package.")
      ),
      artifact("elevation-ui-latest.json", "Elevation browser recovery workflow", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Elevation UI smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const requestedLaunch = data.intercept?.launchRequested === true && data.intercept?.launchRewrittenTo === false;
        const prepared = data.prepared || {};
        const helpersOk =
          prepared.status === "prepared" &&
          prepared.payloadHashVerified === true &&
          Number(prepared.payloadItemCount || 0) >= 1 &&
          Array.isArray(prepared.helperExists) &&
          prepared.helperExists.every((item) => item.exists === true);
        const detailsOk = Boolean(data.detailsAfterElevate?.elevationSection) && !(data.layout?.issues || []).length;
        return requestedLaunch && helpersOk && detailsOk
          ? pass(`Ops UI exposed elevation, requested UAC launch, smoke prepared ${prepared.payloadItemCount} item helper, and rendered elevation details.`)
          : fail("Elevation UI smoke did not prove visible controls, launch intent, helper preparation, and clean details layout.");
      })
    ]
  },
  {
    id: "scripting",
    label: "Plugin and scripting API",
    requirement: "Commands, selected files, pane paths, events, progress, and custom toolbar actions.",
    evidence: [
      ...requiredScripts(["verify:scripting-api", "verify:scripting-mutation-cache"]),
      artifact("scripting-api-latest.json", "Trusted scripting API", (data) =>
        data.direct?.selectedCount >= 1 &&
        data.direct?.result?.listed >= 1 &&
        data.direct?.progress?.phase === "Completed" &&
        data.toolbar?.outputPath &&
        !(data.toolbar?.consoleErrors || []).length &&
        !(data.toolbar?.pageErrors || []).length
          ? pass("Direct helper API and toolbar script both completed without browser errors.")
          : fail("Scripting API did not prove direct context, helper, progress, and toolbar execution.")
      ),
      artifact("scripting-mutation-cache-latest.json", "Trusted script cache and index invalidation", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Scripting mutation-cache status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const cacheInvalidation = data.scriptResult?.cacheInvalidation;
        const backgroundInvalidation = data.scriptResult?.backgroundIndexInvalidation;
        const affectedRoot = (backgroundInvalidation?.roots || []).find((root) => root.id === data.rootId);
        const listingOk =
          Number(cacheInvalidation?.invalidated || 0) >= 1 &&
          data.listing?.afterScript?.cache?.hit !== true &&
          data.listing?.postScriptWarm?.cache?.hit === true;
        const backgroundOk =
          Number(backgroundInvalidation?.affected || 0) >= 1 &&
          affectedRoot?.autoRebuild?.source === "script" &&
          data.rebuiltSearch?.hit === true;
        return listingOk && backgroundOk
          ? pass("Trusted script mutations invalidate warm listings, rewarm cleanly, rebuild background indexes, and search the written file.")
          : fail("Trusted script mutation smoke did not prove listing-cache invalidation plus background-index repair.");
      })
    ]
  },
  {
    id: "accessibility-layout",
    label: "Accessibility, keyboard, and layout verification",
    requirement: "Keyboard reachability, visible focus, screen-reader labels, high contrast, and unsquished headers/toolbars.",
    evidence: [
      ...requiredScripts([
        "verify:accessibility",
        "verify:layout",
        "verify:pane-layout-no-scrollbars",
        "verify:size-analysis-ui",
        "verify:large-folder-ui",
        "verify:interaction-resize",
        "verify:keyboard-workflows-ui"
      ]),
      artifact("accessibility-verification-latest.json", "Accessibility browser audit", (data) =>
        allReportsHaveNoIssues(data) ? pass(`${data.reports?.length || 0} viewport accessibility report(s), 0 issues.`) : fail("Accessibility report has issues.")
      ),
      artifact("layout-verification-latest.json", "Responsive layout audit", (data) => {
        const doubleClicks = (data.reports || []).every((report) => report.interactions?.doubleClickFolder?.insideVisible === true);
        const rowHitTargets = (data.reports || []).every(
          (report) => report.rowHitTargets?.visibleInsideList === true && report.rowHitTargets?.hitMatches === true
        );
        return allHeaderReportsClean(data) && rowHitTargets && doubleClicks
          ? pass(`${data.reports.length} viewport layout report(s), headers clean, row hit targets and double-click navigation proven.`)
          : fail("Layout report has header issues, missing row hit-target proof, or missing double-click proof.");
      }),
      artifact("pane-layout-no-scrollbars-latest.json", "Pane chrome no-scrollbar guard", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Pane no-scrollbar smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const clean = (data.viewportReports || []).length >= 1 && (data.viewportReports || []).every((report) => !(report.issues || []).length);
        return clean
          ? pass(`${data.viewportReports.length} viewport(s) verified with no pathbar, breadcrumb, toolbar, or header scrollbars.`)
          : fail("Pane no-scrollbar report still has pane chrome issues.");
      }),
      artifact("size-analysis-ui-latest.json", "Size Analyzer browser workflow", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Size Analyzer UI smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const foldersOk = (data.ui?.folders || []).some((row) => /media/i.test(row));
        const fileOk = (data.ui?.files || []).some((row) => /movie\.mkv/i.test(row));
        const extensionOk = (data.ui?.extensions || []).some((row) => /\.mkv/i.test(row));
        const scanStripOk = /Scan complete/i.test(data.ui?.scanStrip || "");
        const bandOk = (data.ui?.bands || []).length >= 4;
        const spaceOk = data.apiReport?.space?.available === true && Number(data.apiReport?.space?.totalBytes || 0) > 0;
        const treemapOk = Number(data.ui?.canvas?.coloredPixels || 0) > 500;
        const treemapInteractiveOk =
          /movie\.mkv/i.test(data.treemapHit?.detail || data.ui?.mapDetail || "") &&
          (data.ui?.selectedEntries || []).some((entryPath) => /movie\.mkv$/i.test(entryPath)) &&
          /mapped file block/i.test(data.ui?.canvas?.ariaLabel || "");
        return foldersOk && fileOk && extensionOk && scanStripOk && bandOk && spaceOk && treemapOk && treemapInteractiveOk
          ? pass(`Analyzer scanned ${data.apiReport?.summary?.files || "?"} file(s), rendered charts, painted treemap, and selected a file from the map.`)
          : fail("Size Analyzer smoke did not prove folder/file/extension totals, scan strip, drive context, painted treemap, and clickable map selection.");
      }),
      artifact("keyboard-workflows-ui-latest.json", "Keyboard command workflows", (data) => {
        if (data.status !== "pass" || countFailedChecks(data) > 0) {
          return fail(`Keyboard workflow smoke status is ${data.status || "missing"} with ${countFailedChecks(data)} failures.`);
        }
        const layoutOk = String(data.layout?.className || "").includes("layout-horizontal");
        const quickOk =
          data.quickSearch?.rows?.length === 1 &&
          /1 match/.test(data.quickSearch?.countText || "") &&
          String(data.quickSearch?.rows?.[0]?.text || "").includes("beta-filter-target.txt");
        const uiOk = !Array.isArray(data.keyboardLayout?.issues) || data.keyboardLayout.issues.length === 0;
        return layoutOk && quickOk && uiOk
          ? pass(`Command palette executed layout; quick search filtered ${data.quickSearch.countText}; keyboard UI clean.`)
          : fail("Keyboard workflow smoke did not prove command execution, quick-search filtering, and clean keyboard UI.");
      }),
      artifact("large-folder-ui-latest.json", "Large folder browser UI", (data) => {
        const reports = data.reports || [];
        const clean = reports.every(
          (report) =>
            report?.listingRequests?.[0]?.isWindow === true &&
            Number(report?.windowFirst?.renderedRows || 0) > 0 &&
            Number(report?.windowFirst?.renderedRows || 0) <= 220 &&
            report?.windowFirst?.virtualized === false &&
            (report?.listingRequests || []).some((request) => request.isWindow === false) &&
            !(report.header?.issues || []).length &&
            !(report.consoleErrors || []).length &&
            !(report.pageErrors || []).length &&
            report.virtualInitial?.virtualized === true &&
            report.virtualInitial?.renderedRows < 250
        );
        return data.count >= 10000 && clean
          ? pass(`${data.count} item UI verified window-first paint and bounded virtual rows across ${reports.length} viewport(s).`)
          : fail("Large folder UI did not prove window-first paint, clean headers, no page errors, and bounded virtualization.")
      }),
      artifact("interaction-resize-latest.json", "Resizable UI interactions", (data) => {
        const interactions = data.interactions || {};
        const required = ["navResize", "paneResize", "inspectorResize", "dockResize", "paneRowResize"];
        const missing = required.filter((key) => interactions[key] !== true);
        return !missing.length && interactions.doubleClickFolder?.insideVisible === true
          ? pass("Navigator, pane, preview, dock, row resize, persistence, and double-click all verified.")
          : fail(`Missing resize interactions: ${missing.join(", ") || "double-click"}.`);
      })
    ]
  },
  {
    id: "crash-recovery",
    label: "Crash and recovery tests",
    requirement: "Kill mid-copy, mid-rename, mid-sync, mid-settings save, and desktop backend listener; reopen with sane recovery.",
    evidence: [
      ...requiredScripts(["verify:state-corruption", "verify:crash-recovery", "verify:crash-kill", "verify:desktop-backend-recovery"]),
      artifact("state-corruption-recovery-latest.json", "State corruption recovery", (data) => {
        const checksOk = data.status === "pass" && countFailedChecks(data) === 0;
        const backupRestore = data.scenarios?.backupRestore || {};
        const fallback = data.scenarios?.noBackupFallback || {};
        const backupOk = backupRestore.restoredDensity === "compact" && backupRestore.afterRestoreDensity === "comfortable";
        const fallbackOk = fallback.fallbackDensity === "comfortable" && fallback.secondSaveDensity === "spacious";
        return checksOk && backupOk && fallbackOk
          ? pass("Corrupt state restores from backup, falls back without backup, avoids corrupt backups, and saves again.")
          : fail("State corruption recovery did not prove backup restore, no-backup fallback, and post-recovery writes.");
      }),
      artifact("crash-recovery-latest.json", "Restart recovery", (data) => {
        const recoveries = Object.values(data.recoveries || data.recovered || {});
        const types = new Set(recoveries.map((entry) => entry?.type));
        const requiredTypes = ["copy", "transfer", "sync"];
        const ok =
          requiredTypes.every((type) => types.has(type)) &&
          recoveries.every(
            (entry) =>
              entry?.interrupted === true &&
              entry?.partialCompletionUnverified === true &&
              (entry?.remainingCount === 0 || entry?.canRetryRemaining === true)
          );
        return ok ? pass(`${recoveries.length} seeded interrupted operations reopened as recoverable rows.`) : fail("Restart recovery artifact is missing interrupted recoveries.");
      }),
      artifact("crash-kill-latest.json", "Kill during live operations", (data) => {
        const required = ["copy", "move", "delete", "trash", "sync", "rename"];
        const missing = required.filter((key) => !operationRecoveryOk(data.operations?.[key]));
        const stateOk = data.stateSave?.baselineDensity === data.stateSave?.recoveredDensity && data.stateSave?.interruptedTempFile;
        return !missing.length && stateOk
          ? pass(`Live kill recovery covered ${required.join(", ")} plus atomic state save.`)
          : fail(`Missing live-kill recovery for ${missing.join(", ") || "state save"}.`);
      }),
      artifact("desktop-backend-recovery-latest.json", "Desktop backend recovery", (data) => {
        const recovery = data.recovery || {};
        const ok =
          data.status === "pass" &&
          recovery.before === true &&
          recovery.rendererBefore === true &&
          recovery.down === true &&
          recovery.after === true &&
          recovery.rendererAfter === true &&
          Number(recovery.rows || 0) > 0 &&
          Number(recovery.restarts || 0) >= 1;
        return ok
          ? pass(`Desktop recovered ${recovery.simulated} with ${recovery.rows} visible row(s), restarts=${recovery.restarts}.`)
          : fail("Desktop backend recovery did not prove simulated backend failure, restart, renderer fetch, and visible rows.");
      })
    ]
  },
  {
    id: "release-hardening",
    label: "Release and shell-replacement hardening",
    requirement: "Packaged app, installer, shell integration rehearsal, reversible integration, signing, and updates.",
    evidence: [
      ...requiredScripts([
        "package:dir",
        "package:installer",
        "verify:release-readiness",
        "verify:release-integrity",
        "verify:code-signing",
        "verify:production-signing",
        "verify:production-readiness",
        "build:update-feed",
        "verify:release-update-feed",
        "verify:release-update-feed-desktop",
        "verify:release-bundle",
        "verify:hosted-update-feed",
        "verify:external-proof",
        "verify:auto-update-feed",
        "verify:shell-rehearsal",
        "verify:shell-current-user"
      ]),
      artifact("release-readiness-latest.json", "Release readiness", (data) => {
        if (data.summary?.fail > 0) return fail(`${data.summary.fail} release readiness failure(s).`);
        const warns = countWarnChecks(data);
        return warns ? warn(`${data.summary?.pass || 0} pass, ${warns} production warning(s).`) : pass(`${data.summary?.pass || 0} pass, 0 warnings.`);
      }),
      artifact("release-integrity-latest.json", "Release integrity manifest", async (data) => {
        if (data.status !== "pass" || data.summary?.fail > 0) {
          return fail(`${data.summary?.fail || 1} release integrity failure(s).`);
        }
        const generatedAtMs = Date.parse(data.generatedAt || "");
        if (!Number.isFinite(generatedAtMs)) {
          return fail("Release integrity report has no valid generatedAt timestamp.");
        }
        const changedSources = [];
        for (const source of Array.isArray(data.sources) ? data.sources : []) {
          const currentPath = path.join(workspace, source.relativePath || "");
          try {
            const stat = await fs.stat(currentPath);
            if (Number(stat.mtimeMs || 0) > generatedAtMs + 1000) {
              changedSources.push(source.relativePath || currentPath);
            }
          } catch {
            changedSources.push(source.relativePath || currentPath);
          }
        }
        if (changedSources.length) {
          return fail(`Release integrity report is older than source input(s): ${changedSources.slice(0, 5).join(", ")}.`);
        }
        const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
        const byId = new Map(artifacts.map((entry) => [entry.id, entry]));
        const required = ["setup-installer", "setup-blockmap", "unpacked-exe", "app-asar"];
        const missing = required.filter((id) => !byId.has(id));
        if (missing.length) {
          return fail(`Missing release artifact hash(es): ${missing.join(", ")}.`);
        }
        const badHashes = required.filter((id) => !/^[a-f0-9]{64}$/.test(byId.get(id)?.sha256 || ""));
        if (badHashes.length) {
          return fail(`Invalid release artifact hash(es): ${badHashes.join(", ")}.`);
        }
        return pass(`${artifacts.length} release artifact hash(es), ${data.sources?.length || 0} source hash(es).`);
      }),
      artifact("code-signing-rehearsal-latest.json", "Code-signing rehearsal", async (data) => {
        const generatedAtMs = Date.parse(data.generatedAt || "");
        if (data.status !== "pass" || data.summary?.fail > 0) {
          return fail(`${data.summary?.fail || 1} code-signing rehearsal failure(s).`);
        }
        if (!Number.isFinite(generatedAtMs)) {
          return fail("Code-signing rehearsal report has no valid generatedAt timestamp.");
        }
        const sourcePath = path.join(workspace, data.sourceAfter?.relativePath || "");
        let sourceStat = null;
        try {
          sourceStat = await fs.stat(sourcePath);
        } catch {
          return fail(`Signed source artifact no longer exists: ${sourcePath}.`);
        }
        if (Number(sourceStat.mtimeMs || 0) > generatedAtMs + 1000) {
          return fail("Code-signing rehearsal report is older than the current installer.");
        }
        const ok =
          data.signing?.removedCertificate === true &&
          data.signing?.verifyStatus !== "NotSigned" &&
          data.signing?.signerThumbprint &&
          data.sourceBefore?.sha256 &&
          data.sourceBefore.sha256 === data.sourceAfter?.sha256 &&
          data.signedCopy?.sha256 &&
          data.signedCopy.sha256 !== data.sourceBefore.sha256 &&
          data.signedCopy?.size >= data.sourceBefore?.size;
        return ok
          ? pass(`Temporary cert ${String(data.signing.thumbprint || "").slice(0, 10)}... signed a copied installer and was removed.`)
          : fail("Code-signing rehearsal did not prove copied-installer signing, signer metadata, source preservation, and cert cleanup.");
      }),
      artifact("production-signing-latest.json", "Production Authenticode signing", (data) => {
        if (data.summary?.fail > 0 || data.status === "fail") {
          return fail(`${data.summary?.fail || 1} production signing failure(s).`);
        }
        const signedTargets = (data.signatures || []).filter((signature) => signature.signerThumbprint && signature.status !== "NotSigned");
        if (data.status === "pass" && data.expected?.configured === true) {
          return pass(`${signedTargets.length} production-signed target(s) matched the expected certificate.`);
        }
        return warn("No production signing certificate expectation configured or signed targets are not trusted; set EXPLORE_BETTER_SIGNING_THUMBPRINT or EXPLORE_BETTER_SIGNING_SUBJECT and run verify:production-signing.");
      }),
      artifact("production-readiness-latest.json", "Production readiness manifest", (data) => {
        if (data.summary?.fail > 0 || data.status === "fail") {
          return fail(`${data.summary?.fail || 1} production readiness failure(s).`);
        }
        if (data.localReady !== true) {
          return fail("Production readiness manifest does not mark the local release bundle as ready.");
        }
        const checklist = Array.isArray(data.readinessChecklist) ? data.readinessChecklist : [];
        const requiredLocal = [
          "local-release-readiness-no-fail",
          "local-release-integrity-pass",
          "local-code-signing-rehearsal-pass",
          "local-static-update-feed-pass",
          "local-desktop-update-smoke-pass",
          "local-auto-update-smoke-pass",
          "local-shell-rehearsal-no-fail",
          "local-current-user-shell-pass",
          "local-release-bundle-pass"
        ];
        const missing = requiredLocal.filter((id) => !checklist.some((item) => item.id === id && item.status === "pass"));
        if (missing.length) {
          return fail(`Production readiness manifest is missing local pass gate(s): ${missing.join(", ")}.`);
        }
        const productionCommands = Array.isArray(data.commands?.production) ? data.commands.production : [];
        if (!productionCommands.includes("npm run verify:external-proof -- --strict")) {
          return fail("Production readiness manifest does not include the strict external certification command.");
        }
        const blockers = Array.isArray(data.externalBlockers) ? data.externalBlockers : [];
        return data.productionReady === true
          ? pass("Production readiness manifest says the local and external release gates are complete.")
          : pass(`Local release gates are complete; ${blockers.length} external production blocker(s) are listed explicitly.`);
      }),
      artifact("auto-update-feed-latest.json", "Auto-update configured-feed smoke", (data) => {
        const ok =
          data.status === "pass" &&
          data.updateCheck?.event === "available" &&
          data.updateCheck?.available === true &&
          (data.feed?.requests || []).some((request) => request.path === "/latest.yml");
        return ok
          ? pass(`Local generic feed reported ${data.updateCheck.version}; ${data.feed.requests.length} feed request(s).`)
          : fail("Auto-update feed smoke did not prove configured generic feed lookup and available-version event.");
      }),
      artifact("release-update-feed-latest.json", "Static release update feed", async (data) => {
        if (data.status !== "pass" || data.summary?.fail > 0) {
          return fail(`${data.summary?.fail || 1} release update feed failure(s).`);
        }
        const feed = data.feed || {};
        const assets = Array.isArray(data.assets) ? data.assets : [];
        const sources = Array.isArray(data.sources) ? data.sources : [];
        const byId = new Map(assets.map((entry) => [entry.id, entry]));
        const sourceById = new Map(sources.map((entry) => [entry.id, entry]));
        const installer = byId.get("setup-installer");
        const blockmap = byId.get("setup-blockmap");
        const sourceInstaller = sourceById.get("source-installer");
        const sourceBlockmap = sourceById.get("source-blockmap");
        if (!installer || !blockmap || !sourceInstaller || !sourceBlockmap) {
          return fail("Release update feed report is missing installer/blockmap asset or source records.");
        }
        if (installer.sha256 !== sourceInstaller.sha256 || blockmap.sha256 !== sourceBlockmap.sha256) {
          return fail("Release update feed assets do not match the dist installer/blockmap hashes.");
        }
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(installer.sha512 || "") || !/^[a-f0-9]{64}$/.test(feed.sha256 || "")) {
          return fail("Release update feed hashes are missing or malformed.");
        }
        const feedPath = path.join(workspace, feed.relativePath || "");
        const sourceInstallerPath = path.join(workspace, sourceInstaller.relativePath || "");
        const sourceBlockmapPath = path.join(workspace, sourceBlockmap.relativePath || "");
        for (const itemPath of [feedPath, sourceInstallerPath, sourceBlockmapPath]) {
          try {
            await fs.access(itemPath);
          } catch {
            return fail(`Release update feed path is missing: ${itemPath}.`);
          }
        }
        const generatedAtMs = Date.parse(data.generatedAt || "");
        if (!Number.isFinite(generatedAtMs)) {
          return fail("Release update feed report has no valid generatedAt timestamp.");
        }
        const [installerStat, blockmapStat] = await Promise.all([fs.stat(sourceInstallerPath), fs.stat(sourceBlockmapPath)]);
        if (Number(installerStat.mtimeMs || 0) > generatedAtMs + 1000 || Number(blockmapStat.mtimeMs || 0) > generatedAtMs + 1000) {
          return fail("Release update feed report is older than the current installer or blockmap.");
        }
        const content = String(feed.content || "");
        return content.includes(`version: ${data.package?.version}`) && content.includes(`path: ${installer.relativePath.split("/").pop()}`)
          ? pass(`latest.yml for ${data.package?.version} with installer ${installer.size} bytes and blockmap ${blockmap.size} bytes.`)
          : fail("Release update feed latest.yml does not reference the expected version and installer.");
      }),
      artifact("release-update-feed-desktop-latest.json", "Generated release feed desktop smoke", (data) => {
        const ok =
          data.status === "pass" &&
          data.updateCheck?.event === "not-available" &&
          data.updateCheck?.available === false &&
          data.updateCheck?.version === data.feed?.expectedVersion &&
          (data.feed?.requests || []).some((request) => request.path === "/latest.yml");
        return ok
          ? pass(`Desktop updater consumed generated feed and reported current version ${data.updateCheck.version} as not available.`)
          : fail("Generated release-feed desktop smoke did not prove latest.yml consumption and not-available current-version handling.");
      }),
      artifact("release-bundle-latest.json", "Release bundle manifest", async (data) => {
        if (data.status !== "pass" || data.summary?.fail > 0) {
          return fail(`${data.summary?.fail || 1} release bundle failure(s).`);
        }
        const generatedAtMs = Date.parse(data.generatedAt || "");
        if (!Number.isFinite(generatedAtMs)) {
          return fail("Release bundle report has no valid generatedAt timestamp.");
        }
        const manifestPath = path.join(workspace, data.manifestPath || "dist/release-bundle-manifest.json");
        try {
          await fs.access(manifestPath);
        } catch {
          return fail(`Release bundle manifest is missing: ${manifestPath}.`);
        }
        const checks = new Map((data.checks || []).map((check) => [check.id, check]));
        const requiredChecks = [
          "bundle-artifacts-present",
          "bundle-artifacts-nonempty",
          "bundle-hashes-generated",
          "integrity-report-pass",
          "integrity-hashes-current",
          "update-feed-assets-match",
          "update-feed-latest-yml-current",
          "update-feed-desktop-smoke-pass",
          "code-signing-rehearsal-pass",
          "shell-current-user-pass",
          "release-readiness-no-fail"
        ];
        const missingChecks = requiredChecks.filter((id) => checks.get(id)?.status !== "pass");
        if (missingChecks.length) {
          return fail(`Release bundle missing pass check(s): ${missingChecks.join(", ")}.`);
        }
        const artifacts = Array.isArray(data.manifest?.artifacts) ? data.manifest.artifacts : [];
        const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
        const requiredArtifacts = ["setup-installer", "setup-blockmap", "unpacked-exe", "app-asar", "feed-latest-yml", "feed-installer", "feed-blockmap"];
        const missingArtifacts = requiredArtifacts.filter((id) => !artifactIds.has(id));
        if (missingArtifacts.length) {
          return fail(`Release bundle missing artifact(s): ${missingArtifacts.join(", ")}.`);
        }
        return pass(`${artifacts.length} bundled artifact(s) cross-checked against integrity, update feed, signing, shell, and readiness evidence.`);
      }),
      artifact("hosted-update-feed-latest.json", "Hosted production update feed", (data) => {
        if (data.summary?.fail > 0 || data.status === "fail") {
          return fail(`${data.summary?.fail || 1} hosted update feed failure(s).`);
        }
        if (data.status === "pass") {
          const installer = (data.assets || []).find((asset) => asset.id === "setup-installer");
          return pass(`Hosted latest.yml and release assets matched ${data.package?.version}; installer probe ${installer?.probe?.method || "ok"}.`);
        }
        return warn("No hosted production update feed URL configured; set EXPLORE_BETTER_UPDATE_URL or EB_UPDATE_URL and run verify:hosted-update-feed.");
      }),
      artifact("external-proof-latest.json", "Consolidated external proof", (data) => {
        if (data.summary?.fail > 0 || data.status === "fail") {
          return fail(`${data.summary?.fail || 1} external proof failure(s).`);
        }
        if (data.status === "pass" && data.strict === true) {
          return pass("Strict external proof passed for attached device, production signing, and hosted update feed.");
        }
        const guide = data.guide?.strictCommand || "npm run verify:external-proof -- --strict";
        return warn(`External proof is advisory until hardware/cert/feed are configured. Run ${guide}.`);
      }),
      artifact("shell-rehearsal-latest.json", "Shell replacement rehearsal", (data) =>
        data.summary?.fail > 0
          ? fail(`${data.summary.fail} shell rehearsal failure(s).`)
          : data.summary?.warn > 0
            ? warn(`${data.summary.pass} pass, ${data.summary.warn} rehearsal warning(s).`)
            : pass(`${data.summary?.pass || 0} rehearsal checks passed.`)
      ),
      artifact("shell-current-user-latest.json", "Current-user shell install/revert", (data) =>
        data.status === "pass" &&
        data.summary?.fail === 0 &&
        (data.checks || []).some((check) => check.id === "installed-handler-shell-open" && check.status === "pass") &&
        Array.isArray(data.registry?.mismatchedKeys) &&
        data.registry.mismatchedKeys.length === 0 &&
        Array.isArray(data.registry?.mismatchedStatus) &&
        data.registry.mismatchedStatus.length === 0
          ? pass(`${data.summary?.pass || 0} checks passed; installed handler opened a target and real HKCU shell keys were restored.`)
          : fail("Current-user shell smoke did not prove real HKCU install, installed-handler shell-open, and exact restore.")
      )
    ]
  }
];

async function evaluateArea(area, pkg) {
  const checks = [];
  for (const entry of area.evidence) {
    const result = entry.type === "script" ? entry.check(pkg) : await entry.check(pkg);
    checks.push({
      type: entry.type,
      name: entry.name,
      label: entry.label || entry.name,
      status: result.status,
      detail: result.detail,
      path: result.path || null,
      generatedAt: result.generatedAt || null,
      ageMs: result.ageMs ?? null
    });
  }
  return {
    id: area.id,
    label: area.label,
    requirement: area.requirement,
    status: worstStatus(checks),
    checks
  };
}

function tableValue(value) {
  return short(value, 520).replaceAll("|", "\\|");
}

function markdownReport(report) {
  const lines = [
    "# Explore Better Goal Stress Audit",
    "",
    `Generated: ${report.generatedAt}`,
    `Evidence max age: ${report.maxAgeHours}h`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.`,
    "",
    "| Status | Area | Requirement |",
    "| --- | --- | --- |"
  ];
  for (const area of report.areas) {
    lines.push(`| ${area.status.toUpperCase()} | ${tableValue(area.label)} | ${tableValue(area.requirement)} |`);
  }
  for (const area of report.areas) {
    lines.push("", `## ${area.label}`, "");
    lines.push(`Status: ${area.status.toUpperCase()}`);
    lines.push("");
    lines.push("| Status | Evidence | Detail |");
    lines.push("| --- | --- | --- |");
    for (const check of area.checks) {
      lines.push(`| ${check.status.toUpperCase()} | ${tableValue(check.label)} | ${tableValue(check.detail)} |`);
    }
  }
  const warnings = report.areas.flatMap((area) =>
    area.checks.filter((check) => check.status === "warn").map((check) => `${area.label}: ${check.label}: ${check.detail}`)
  );
  if (warnings.length) {
    lines.push("", "## Warnings", "");
    for (const item of warnings) lines.push(`- ${item}`);
  }
  const failures = report.areas.flatMap((area) =>
    area.checks.filter((check) => check.status === "fail").map((check) => `${area.label}: ${check.label}: ${check.detail}`)
  );
  if (failures.length) {
    lines.push("", "## Failures", "");
    for (const item of failures) lines.push(`- ${item}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const packagePath = path.join(workspace, "package.json");
  const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
  const areas = [];
  for (const area of coverageAreas) {
    areas.push(await evaluateArea(area, pkg));
  }
  const summary = {
    pass: areas.filter((area) => area.status === "pass").length,
    warn: areas.filter((area) => area.status === "warn").length,
    fail: areas.filter((area) => area.status === "fail").length
  };
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    maxAgeHours,
    summary,
    areas
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`goal stress audit: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.warn) {
    const warningLabels = areas.filter((area) => area.status === "warn").map((area) => area.id).join(", ");
    console.log(`warnings: ${warningLabels}`);
  }
  if (summary.fail) {
    const failedLabels = areas.filter((area) => area.status === "fail").map((area) => area.id).join(", ");
    console.error(`failures: ${failedLabels}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
