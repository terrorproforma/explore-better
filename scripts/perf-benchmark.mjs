import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const paneValueCollator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
let serverOutput = "";

function cpuTimesSnapshot() {
  return os.cpus().reduce(
    (totals, cpu) => {
      const times = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      totals.idle += cpu.times.idle;
      totals.total += times;
      return totals;
    },
    { idle: 0, total: 0 }
  );
}

function cpuLoadBetween(start, end) {
  const total = end.total - start.total;
  const idle = end.idle - start.idle;
  return total > 0 ? Math.round((100 - (idle / total) * 100) * 10) / 10 : null;
}

function loadProfile(cpuPercent) {
  if (!Number.isFinite(cpuPercent)) return "unknown";
  if (cpuPercent < 20) return "light";
  if (cpuPercent < 50) return "moderate";
  return "heavy";
}

function pathWithin(candidate, parent) {
  if (!candidate || !parent) return false;
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function benchmarkEnvironment(targetPath, startedAt, cpuStarted) {
  const stat = await fs.statfs(targetPath).catch(() => null);
  const oneDriveRoots = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].filter(Boolean);
  const systemCpuLoadPercent = cpuLoadBetween(cpuStarted, cpuTimesSnapshot());
  return {
    cpuModel: os.cpus()[0]?.model || "unknown",
    systemCpuLoadPercent,
    activeProcessLoad: loadProfile(systemCpuLoadPercent),
    measuredDurationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    volume: {
      root: path.parse(path.resolve(targetPath)).root,
      fileSystemType: stat ? `0x${(Number(stat.type) >>> 0).toString(16)}` : "unknown",
      blockSize: stat ? Number(stat.bsize) : null
    },
    oneDrive: {
      configured: oneDriveRoots.length > 0,
      workspaceWithinSyncRoot: oneDriveRoots.some((root) => pathWithin(workspace, root)),
      fixtureWithinSyncRoot: oneDriveRoots.some((root) => pathWithin(targetPath, root))
    }
  };
}

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function parseCountList(raw) {
  return raw
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0)
    .sort((a, b) => a - b);
}

function parseCounts() {
  return parseCountList(optionValue("--counts", process.env.EB_PERF_COUNTS || "1000,10000"));
}

function parseMediaCounts() {
  return parseCountList(optionValue("--media-counts", process.env.EB_PERF_MEDIA_COUNTS || "250"));
}

function parseContentCounts() {
  return parseCountList(optionValue("--content-counts", process.env.EB_PERF_CONTENT_COUNTS || "1000"));
}

function parseNetworkPaths() {
  return optionValue("--network-paths", process.env.EB_PERF_NETWORK_PATHS || "")
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_PERF_KEEP_FIXTURE === "1";
}

function requestJson(baseUrl, route, options = {}) {
  return fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  }).then(async (response) => {
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(data.error || `Request failed: ${response.status}`);
    }
    return data;
  });
}

async function waitForServer(baseUrl, child) {
  const started = performance.now();
  while (performance.now() - started < 10000) {
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

async function writeBatch(files) {
  await Promise.all(files.map(([file, text]) => fs.writeFile(file, text)));
}

async function ensureFixture(root, count) {
  const dir = path.join(root, `count-${count}`);
  await fs.mkdir(dir, { recursive: true });
  const marker = path.join(dir, ".fixture-ready.json");
  try {
    const parsed = JSON.parse(await fs.readFile(marker, "utf8"));
    if (parsed.count === count) return dir;
  } catch {
    // Build below.
  }
  const batch = [];
  for (let index = 0; index < count; index += 1) {
    const ext = index % 10 === 0 ? ".jpg" : index % 7 === 0 ? ".md" : index % 5 === 0 ? ".json" : ".txt";
    const name = `target-${String(index).padStart(6, "0")}${ext}`;
    batch.push([path.join(dir, name), `fixture ${index}\nkind ${ext}\n`]);
    if (batch.length >= 500) {
      await writeBatch(batch.splice(0));
    }
  }
  if (batch.length) {
    await writeBatch(batch);
  }
  await fs.writeFile(marker, JSON.stringify({ count, generatedAt: new Date().toISOString() }, null, 2));
  return dir;
}

async function ensureMediaFixture(root, count) {
  const dir = path.join(root, `media-${count}`);
  await fs.mkdir(dir, { recursive: true });
  const marker = path.join(dir, ".fixture-ready.json");
  try {
    const parsed = JSON.parse(await fs.readFile(marker, "utf8"));
    if (parsed.count === count && parsed.kind === "png") return dir;
  } catch {
    // Build below.
  }
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR42mP8z8Dwn4ECwESJ5lEDRg0YNWDUgFEDRg0A6BwCH2n4K0EAAAAASUVORK5CYII=",
    "base64"
  );
  const batch = [];
  for (let index = 0; index < count; index += 1) {
    const name = `photo-${String(index).padStart(6, "0")}.png`;
    batch.push([path.join(dir, name), png]);
    if (batch.length >= 500) {
      await writeBatch(batch.splice(0));
    }
  }
  if (batch.length) {
    await writeBatch(batch);
  }
  await fs.writeFile(marker, JSON.stringify({ count, kind: "png", generatedAt: new Date().toISOString() }, null, 2));
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

function summarizeList(data) {
  return {
    returned: data.entries?.length || 0,
    scanned: data.timing?.scanned || 0,
    totalMs: data.timing?.totalMs || 0,
    readMs: data.timing?.readMs || 0,
    statMs: data.timing?.statMs || 0,
    filterMs: data.timing?.filterMs || 0,
    signatureMs: data.timing?.signatureMs || 0,
    dimensionsCacheMs: data.timing?.dimensionsCacheMs || 0,
    concurrency: data.timing?.concurrency || 0,
    dimensionsCache: data.dimensionsCache || null,
    cache: data.timing?.cache || data.cache || null
  };
}

function kindMatches(entry, kindFilter) {
  if (!kindFilter || kindFilter === "all") return true;
  if (kindFilter === "folders") return Boolean(entry.isDirectory);
  if (kindFilter === "files") return Boolean(entry.isFile);
  const kind = String(entry.kind || "").toLowerCase();
  if (kindFilter === "images") return kind === "image";
  if (kindFilter === "text") return kind === "text";
  if (kindFilter === "documents") return kind === "document";
  if (kindFilter === "media") return kind === "audio" || kind === "video";
  if (kindFilter === "archives") return kind === "archive";
  if (kindFilter === "apps") return kind === "application";
  return true;
}

function sortableValue(entry, key) {
  if (key === "size") return Number(entry.size || 0);
  if (key === "modified") return Number(entry.modified || 0);
  if (key === "created") return Number(entry.created || 0);
  if (key === "accessed") return Number(entry.accessed || 0);
  if (key === "extension") return entry.extension || "";
  if (key === "kind") return entry.kind || "";
  if (key === "parent") return entry.parent || "";
  if (key === "dimensions") return Number(entry.dimensionPixels || entry.dimensions?.pixels || 0);
  return entry.name || "";
}

function entrySearchText(entry) {
  const label = entry.label || {};
  return [
    entry.name,
    entry.kind,
    entry.parent,
    entry.attributeText,
    entry.linkType,
    entry.linkTarget,
    entry.dimensionText || entry.dimensions?.text,
    label.name,
    label.notes
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function clientFilter(entries, query, options = {}) {
  const filter = String(query || "").trim().toLowerCase();
  const kindFilter = options.kindFilter || "all";
  const labelFilter = options.labelFilter || "all";
  const sortKey = options.sortKey || "name";
  const sortDir = options.sortDir === "desc" ? "desc" : "asc";
  const factor = sortDir === "asc" ? 1 : -1;
  const visible = entries.filter((entry) => {
    const label = entry.label || {};
    const matchesText = filter ? entrySearchText(entry).includes(filter) : true;
    const matchesLabel =
      labelFilter === "all" ||
      (labelFilter === "any" && entry.label) ||
      (entry.label && entry.label.color === labelFilter);
    return matchesText && matchesLabel && kindMatches(entry, kindFilter);
  });
  visible.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory && sortKey === "name") {
      return a.isDirectory ? -1 : 1;
    }
    const left = sortableValue(a, sortKey);
    const right = sortableValue(b, sortKey);
    if (["size", "dimensions", "modified", "created", "accessed"].includes(sortKey)) {
      return ((left || 0) - (right || 0)) * factor;
    }
    return paneValueCollator.compare(String(left), String(right)) * factor;
  });
  return {
    returned: visible.length,
    first: visible[0]?.name || "",
    last: visible.at(-1)?.name || ""
  };
}

function summarizeSearch(data) {
  return {
    returned: data.entries?.length || data.results?.length || 0,
    scanned: data.scanned || data.timing?.scanned || 0,
    contentScanned: data.contentScanned || 0,
    truncated: data.truncated === true,
    timing: data.timing || null
  };
}

async function waitForBackgroundIndex(baseUrl, rootId) {
  const started = performance.now();
  while (performance.now() - started < 30000) {
    const overview = await requestJson(baseUrl, "/api/background-indexes");
    const root = overview.roots?.find((item) => item.id === rootId);
    if (!root) {
      throw new Error("Background index root disappeared.");
    }
    if (root.job?.status === "error") {
      throw new Error(root.job.error || "Background index failed.");
    }
    if (!root.job || root.job.status === "complete") {
      return root;
    }
    const elapsed = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, elapsed < 1000 ? 25 : 100));
  }
  throw new Error("Background index did not complete within 30 seconds.");
}

async function benchmarkBackgroundIndex(baseUrl, dir, count) {
  const started = await requestJson(baseUrl, "/api/background-indexes/start", {
    method: "POST",
    body: JSON.stringify({
      path: dir,
      recursive: true,
      includeDimensions: false,
      includeLinks: false,
      maxFolders: 8,
      maxEntries: Math.max(count + 100, 1000)
    })
  });
  const rootId = started.job?.rootId || started.roots?.[0]?.id;
  if (!rootId) {
    throw new Error("Background index did not return a root id.");
  }
  const root = await waitForBackgroundIndex(baseUrl, rootId);
  const query = `target-${String(count - 1).padStart(6, "0")}`;
  const search = await timed("background-index-search", () =>
    requestJson(baseUrl, `/api/background-indexes/search?q=${encodeURIComponent(query)}&rootId=${encodeURIComponent(rootId)}&limit=20`)
  );
  return {
    root: {
      id: root.id,
      path: root.path,
      search: root.search || root.lastStats || null
    },
    search: {
      label: search.label,
      wallMs: search.wallMs,
      result: summarizeSearch(search.result)
    }
  };
}

async function benchmarkBackgroundContentIndex(baseUrl, dir, count) {
  const started = await requestJson(baseUrl, "/api/background-indexes/start", {
    method: "POST",
    body: JSON.stringify({
      path: dir,
      recursive: true,
      includeDimensions: false,
      includeLinks: false,
      includeContent: true,
      maxFolders: 8,
      maxEntries: Math.max(count + 100, 1000),
      maxContentBytes: 4096,
      maxContentFiles: Math.max(count + 10, 1000)
    })
  });
  const rootId = started.job?.rootId || started.roots?.[0]?.id;
  if (!rootId) {
    throw new Error("Background content index did not return a root id.");
  }
  const root = await waitForBackgroundIndex(baseUrl, rootId);
  const query = `fixture ${count - 1}`;
  const search = await timed("background-content-search", () =>
    requestJson(baseUrl, `/api/background-indexes/search?q=${encodeURIComponent(query)}&rootId=${encodeURIComponent(rootId)}&limit=20`)
  );
  return {
    root: {
      id: root.id,
      path: root.path,
      search: root.search || root.lastStats || null
    },
    search: {
      label: search.label,
      wallMs: search.wallMs,
      result: summarizeSearch(search.result)
    }
  };
}

async function benchmarkNetworkPath(baseUrl, targetPath) {
  const listQuery = `/api/list?path=${encodeURIComponent(targetPath)}&includeSignature=true`;
  const cold = await timed("network-cold-list", async () => summarizeList(await requestJson(baseUrl, listQuery)));
  const warm = await timed("network-warm-list", async () => summarizeList(await requestJson(baseUrl, listQuery)));
  const search = await timed("network-index-search", async () => {
    await requestJson(baseUrl, "/api/index/build", {
      method: "POST",
      body: JSON.stringify({ path: targetPath, wait: true, showHidden: true })
    });
    return searchFolderIndexResult(
      await requestJson(baseUrl, `/api/index/search?path=${encodeURIComponent(targetPath)}&q=.`)
    );
  });
  return { path: targetPath, cold, warm, search };
}

function searchFolderIndexResult(data) {
  return {
    indexed: data.indexed,
    returned: data.results?.length || 0,
    timing: data.timing || null,
    index: data.index || null
  };
}

function markdownReport(report) {
  const rows = report.runs
    .map(
      (run) =>
        `| ${run.count} | ${run.cold.wallMs} | ${run.cold.result.totalMs} | ${run.warm.wallMs} | ${run.warm.result.totalMs} | ${run.filterBroad.wallMs} | ${run.filterNarrow.wallMs} | ${run.apiSearch.wallMs} | ${run.indexBuild.wallMs} | ${run.indexSearch.wallMs} | ${run.indexSearch.result.timing?.searchMs ?? ""} | ${run.backgroundIndex.search.wallMs} | ${run.backgroundIndex.search.result.timing?.searchMs ?? ""} |`
    )
    .join("\n");
  const mediaRows = (report.mediaRuns || [])
    .map(
      (run) =>
        `| ${run.count} | ${run.cold.wallMs} | ${run.cold.result.totalMs} | ${run.cold.result.dimensionsCache?.updates ?? 0} | ${run.warm.wallMs} | ${run.warm.result.totalMs} | ${run.warm.result.dimensionsCache?.hits ?? 0} | ${run.indexBuild.wallMs} | ${run.indexBuild.result.dimensionsCache?.hits ?? 0} |`
    )
    .join("\n");
  const mediaSection = mediaRows
    ? `
## Image Metadata Cache

| Images | Cold wall ms | Cold API ms | Cold cache updates | Warm wall ms | Warm API ms | Warm cache hits | Index build wall ms | Index cache hits |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${mediaRows}
`
    : "";
  const contentRows = (report.contentRuns || [])
    .map(
      (run) =>
        `| ${run.count} | ${run.buildWallMs} | ${run.root.search?.buildMs ?? ""} | ${run.root.search?.contentIndexed ?? 0} | ${run.root.search?.contentSkipped ?? 0} | ${run.search.wallMs} | ${run.search.result.timing?.searchMs ?? ""} | ${run.search.result.returned ?? 0} |`
    )
    .join("\n");
  const contentSection = contentRows
    ? `
## Background Content Index

| Files | Build wall ms | Build API ms | Text indexed | Text skipped | Content search wall ms | Content search API ms | Returned |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${contentRows}
`
    : "";
  const networkRows = (report.networkRuns || [])
    .map(
      (run) =>
        run.error
          ? `| ${run.path} | error | ${run.error} |  |  |  |`
          : `| ${run.path} | ${run.cold.wallMs} | ${run.cold.result.totalMs} | ${run.warm.wallMs} | ${run.warm.result.totalMs} | ${run.search.wallMs} |`
    )
    .join("\n");
  const networkSection = networkRows
    ? `
## Network Paths

| Path | Cold wall ms | Cold API ms | Warm wall ms | Warm API ms | Index/search wall ms |
| --- | ---: | ---: | ---: | ---: | ---: |
${networkRows}
`
    : `
## Network Paths

No network paths were configured. Set \`EB_PERF_NETWORK_PATHS="\\\\server\\share|Z:\\folder"\` or pass \`--network-paths\` to include SMB/UNC/drive-backed paths.
`;
  return `# Explore Better Performance Benchmark

Generated: ${report.generatedAt}

Fixture root: \`${report.fixtureRoot}\`

| Items | Cold wall ms | Cold API ms | Warm wall ms | Warm API ms | Broad filter wall ms | Narrow filter wall ms | API search wall ms | Index build wall ms | Index search wall ms | Index search API ms | BG search wall ms | BG search API ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}
${mediaSection}
${contentSection}
${networkSection}

Notes:
- Use \`npm run perf:bench:100k\` for the 1k/10k/100k stress run.
- Use \`EB_PERF_COUNTS=1000,10000,100000 npm run perf:bench\` for custom counts.
- Use \`EB_PERF_MEDIA_COUNTS=250,1000 npm run perf:bench\` for thumbnail-ish image metadata cache runs.
- Use \`EB_PERF_CONTENT_COUNTS=1000,10000 npm run perf:bench\` for opt-in background text-content indexing runs.
- Use \`EB_PERF_NETWORK_PATHS="\\\\server\\share|Z:\\folder" npm run perf:bench\` to include network path cold/warm/index timings.
- Broad/narrow filter timings mirror the pane-visible filter/sort path in JavaScript on the listed entries.
- Warm search is served from the persistent folder index under the app-data index cache.
- Background search is served from the aggregate background-index cache, not a live filesystem crawl.
- Background content search is opt-in and bounded by text-file count plus per-file byte caps.
- Image metadata runs list real PNG fixtures with \`includeDimensions=true\` to measure persistent dimension-cache updates and hits.
`;
}

async function main() {
  const benchmarkStartedAt = performance.now();
  const cpuStarted = cpuTimesSnapshot();
  await fs.mkdir(artifactsDir, { recursive: true });
  const counts = parseCounts();
  if (!counts.length) {
    throw new Error("No benchmark counts configured.");
  }
  const runRoot = path.join(artifactsDir, `perf-${stamp}`);
  const fixtureRoot = optionValue("--fixture", process.env.EB_PERF_FIXTURE || path.join(runRoot, "fixture"));
  const mediaCounts = parseMediaCounts();
  const contentCounts = parseContentCounts();
  const networkPaths = parseNetworkPaths();
  const appData = path.join(runRoot, "appdata");
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.mkdir(appData, { recursive: true });

  const port = Number(optionValue("--port", process.env.PORT || 47000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitForServer(baseUrl, server);
    const runs = [];
    for (const count of counts) {
      const dir = await ensureFixture(fixtureRoot, count);
      const query = `/api/list?path=${encodeURIComponent(dir)}&includeSignature=true`;
      const cold = await timed("cold-list", async () => summarizeList(await requestJson(baseUrl, query)));
      const warmListRaw = await requestJson(baseUrl, query);
      const warm = {
        label: "warm-list",
        wallMs: 0,
        result: summarizeList(warmListRaw)
      };
      const warmTiming = await timed("warm-list", async () => summarizeList(await requestJson(baseUrl, query)));
      warm.wallMs = warmTiming.wallMs;
      warm.result = warmTiming.result;
      const filterBroad = await timed("client-filter-broad", () =>
        Promise.resolve(clientFilter(warmListRaw.entries || [], "target", { sortKey: "name" }))
      );
      const filterNarrow = await timed("client-filter-narrow", () =>
        Promise.resolve(
          clientFilter(warmListRaw.entries || [], `target-${String(count - 1).padStart(6, "0")}`, {
            sortKey: "name"
          })
        )
      );
      const apiSearch = await timed("api-search", async () =>
        summarizeSearch(
          await requestJson(
            baseUrl,
            `/api/search?path=${encodeURIComponent(dir)}&q=${encodeURIComponent(`target-${String(count - 1).padStart(6, "0")}`)}&limit=20`
          )
        )
      );
      const indexBuild = await timed("index-build", () =>
        requestJson(baseUrl, "/api/index/build", {
          method: "POST",
          body: JSON.stringify({ path: dir, wait: true, showHidden: true })
        })
      );
      const indexSearch = await timed("index-search", () =>
        requestJson(baseUrl, `/api/index/search?path=${encodeURIComponent(dir)}&q=target-${String(count - 1).padStart(6, "0")}`)
      );
      const backgroundIndexBuild = await timed("background-index-build", () =>
        benchmarkBackgroundIndex(baseUrl, dir, count)
      );
      runs.push({
        count,
        path: dir,
        cold,
        warm,
        filterBroad,
        filterNarrow,
        apiSearch,
        indexBuild: {
          label: indexBuild.label,
          wallMs: indexBuild.wallMs,
          result: indexBuild.result.index
        },
        indexSearch,
        backgroundIndex: {
          buildWallMs: backgroundIndexBuild.wallMs,
          ...backgroundIndexBuild.result
        }
      });
      console.log(
        `${count} items: cold ${cold.wallMs} ms, warm ${warm.wallMs} ms, filter ${filterNarrow.wallMs} ms, index search ${indexSearch.wallMs} ms, bg search ${backgroundIndexBuild.result.search.wallMs} ms`
      );
    }
    const mediaRuns = [];
    for (const count of mediaCounts) {
      const dir = await ensureMediaFixture(fixtureRoot, count);
      const query = `/api/list?path=${encodeURIComponent(dir)}&includeDimensions=true&includeSignature=true`;
      const cold = await timed("cold-image-metadata", async () => summarizeList(await requestJson(baseUrl, query)));
      const warm = await timed("warm-image-metadata", async () => summarizeList(await requestJson(baseUrl, query)));
      const indexBuild = await timed("index-build-image-metadata", async () => {
        const response = await requestJson(baseUrl, "/api/index/build", {
          method: "POST",
          body: JSON.stringify({ path: dir, wait: true, showHidden: true, includeDimensions: true })
        });
        return response.index;
      });
      const indexSearch = await timed("index-search-image", () =>
        requestJson(baseUrl, `/api/index/search?path=${encodeURIComponent(dir)}&q=photo-${String(count - 1).padStart(6, "0")}`)
      );
      mediaRuns.push({
        count,
        path: dir,
        cold,
        warm,
        indexBuild,
        indexSearch
      });
      console.log(
        `${count} images: cold ${cold.wallMs} ms (${cold.result.dimensionsCache?.updates || 0} cache updates), warm ${warm.wallMs} ms (${warm.result.dimensionsCache?.hits || 0} cache hits)`
      );
    }

    const contentRuns = [];
    for (const count of contentCounts) {
      const dir = await ensureFixture(fixtureRoot, count);
      const contentIndex = await timed("background-content-index-build", () =>
        benchmarkBackgroundContentIndex(baseUrl, dir, count)
      );
      contentRuns.push({
        count,
        path: dir,
        buildWallMs: contentIndex.wallMs,
        ...contentIndex.result
      });
      console.log(
        `${count} content files: build ${contentIndex.wallMs} ms, content search ${contentIndex.result.search.wallMs} ms`
      );
    }

    const networkRuns = [];
    for (const networkPath of networkPaths) {
      try {
        const networkRun = await benchmarkNetworkPath(baseUrl, networkPath);
        networkRuns.push(networkRun);
        console.log(
          `network ${networkPath}: cold ${networkRun.cold.wallMs} ms, warm ${networkRun.warm.wallMs} ms`
        );
      } catch (error) {
        networkRuns.push({ path: networkPath, error: error.message || String(error) });
        console.log(`network ${networkPath}: ${error.message || error}`);
      }
    }

    const environment = await benchmarkEnvironment(fixtureRoot, benchmarkStartedAt, cpuStarted);
    const report = {
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      cpuCount: os.cpus().length,
      node: process.version,
      environment,
      fixtureRoot,
      appData,
      baseUrl,
      runs,
      mediaRuns,
      contentRuns,
      networkRuns
    };
    const jsonPath = path.join(artifactsDir, "perf-benchmark-latest.json");
    const mdPath = path.join(artifactsDir, "perf-benchmark-latest.md");
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
    await fs.writeFile(mdPath, markdownReport(report));
    console.log(`wrote ${jsonPath}`);
    console.log(`wrote ${mdPath}`);
  } finally {
    server.kill();
    if (!keepFixture() && !optionValue("--fixture", process.env.EB_PERF_FIXTURE || "")) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(serverOutput);
  console.error(error);
  process.exitCode = 1;
});
