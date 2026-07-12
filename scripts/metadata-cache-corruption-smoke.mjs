import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `metadata-cache-corruption-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const metadataCacheRoot = path.join(appData, "ExploreBetter", "MetadataCache");
const latestJsonPath = path.join(artifactsDir, "metadata-cache-corruption-latest.json");
const latestMdPath = path.join(artifactsDir, "metadata-cache-corruption-latest.md");
const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function countOption() {
  const value = Number(optionValue("--count", process.env.EB_METADATA_CACHE_CORRUPTION_COUNT || "16"));
  return Number.isInteger(value) && value > 1 ? value : 16;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_METADATA_CACHE_CORRUPTION_KEEP_FIXTURE === "1";
}

function pathIdentity(itemPath) {
  const resolved = path.resolve(itemPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function cacheFileForFolder(folderPath) {
  const id = crypto.createHash("sha256").update(pathIdentity(folderPath)).digest("hex").slice(0, 32);
  return path.join(metadataCacheRoot, "Dimensions", `${id}.json`);
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
  if (!ok) {
    throw new Error(`${id}: ${detail}`);
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
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
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

async function prepareFixture(count) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.mkdir(metadataCacheRoot, { recursive: true });
  const images = [];
  for (let index = 0; index < count; index += 1) {
    const imagePath = path.join(fixtureRoot, `image-${String(index).padStart(3, "0")}.png`);
    await fs.writeFile(imagePath, png1x1);
    images.push(imagePath);
  }
  await fs.writeFile(path.join(fixtureRoot, "notes.txt"), "non-image control\n", "utf8");
  return { images };
}

async function seedPoisonedCache(images) {
  const cacheFile = cacheFileForFolder(fixtureRoot);
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  const firstStats = await fs.stat(images[0]);
  const secondStats = await fs.stat(images[1]);
  const entries = {
    [pathIdentity(images[0])]: {
      size: firstStats.size,
      modified: Math.round(firstStats.mtimeMs),
      extension: ".png",
      dimensions: { width: 1, height: 1 },
      cachedAt: new Date().toISOString()
    },
    [pathIdentity(images[1])]: {
      size: secondStats.size + 1000,
      modified: Math.round(secondStats.mtimeMs),
      extension: ".png",
      dimensions: { width: 999, height: 999 },
      cachedAt: new Date().toISOString()
    },
    "bad-dimensions": {
      size: 12,
      modified: Date.now(),
      extension: ".png",
      dimensions: { width: "nope", height: 1 },
      cachedAt: "not a date"
    },
    "bad-extension": {
      size: 12,
      modified: Date.now(),
      extension: ".txt",
      dimensions: { width: 1, height: 1 },
      cachedAt: new Date().toISOString()
    },
    "bad-value": "not an object"
  };
  for (let index = 0; index < 40; index += 1) {
    entries[`zombie-${index}`] = {
      size: 10,
      modified: Date.now(),
      extension: ".png",
      dimensions: { width: 1, height: 1 },
      cachedAt: new Date().toISOString()
    };
  }
  await fs.writeFile(
    cacheFile,
    JSON.stringify(
      {
        version: 1,
        path: fixtureRoot,
        pathKey: pathIdentity(fixtureRoot),
        updatedAt: new Date().toISOString(),
        entries
      },
      null,
      2
    ),
    "utf8"
  );
  return { cacheFile, seededEntries: Object.keys(entries).length };
}

async function listWithDimensions(baseUrl) {
  return requestJson(
    baseUrl,
    `/api/list?${new URLSearchParams({
      path: fixtureRoot,
      includeDimensions: "true",
      includeSignature: "true",
      bypassCache: "true"
    })}`
  );
}

function imageEntries(listing) {
  return (listing.entries || []).filter((entry) => entry.extension === ".png");
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Metadata Cache Corruption Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Cache Repair

| Stage | Hits | Misses | Updates | Stale | Pruned | Invalid | Repaired | Entries |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| Poisoned repair | ${report.poisonedRepair.dimensionsCache.hits} | ${report.poisonedRepair.dimensionsCache.misses} | ${report.poisonedRepair.dimensionsCache.updates} | ${report.poisonedRepair.dimensionsCache.stale} | ${report.poisonedRepair.dimensionsCache.pruned} | ${report.poisonedRepair.dimensionsCache.invalidEntries} | ${report.poisonedRepair.dimensionsCache.repaired} | ${report.poisonedRepair.dimensionsCache.entries} |
| Warm cache | ${report.warm.dimensionsCache.hits} | ${report.warm.dimensionsCache.misses} | ${report.warm.dimensionsCache.updates} | ${report.warm.dimensionsCache.stale} | ${report.warm.dimensionsCache.pruned} | ${report.warm.dimensionsCache.invalidEntries} | ${report.warm.dimensionsCache.repaired} | ${report.warm.dimensionsCache.entries} |
| Broken JSON repair | ${report.brokenJsonRepair.dimensionsCache.hits} | ${report.brokenJsonRepair.dimensionsCache.misses} | ${report.brokenJsonRepair.dimensionsCache.updates} | ${report.brokenJsonRepair.dimensionsCache.stale} | ${report.brokenJsonRepair.dimensionsCache.pruned} | ${report.brokenJsonRepair.dimensionsCache.invalidEntries} | ${report.brokenJsonRepair.dimensionsCache.repaired} | ${report.brokenJsonRepair.dimensionsCache.entries} |
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const count = countOption();
  const fixture = await prepareFixture(count);
  const { cacheFile, seededEntries } = await seedPoisonedCache(fixture.images);
  const port = Number(optionValue("--port", process.env.PORT || 58200 + Math.floor(Math.random() * 4000)));
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

  let poisonedRepair = null;
  let warm = null;
  let brokenJsonRepair = null;
  let persistedAfterPoison = null;
  let persistedAfterBroken = null;
  try {
    await waitForServer(baseUrl, server);

    poisonedRepair = await listWithDimensions(baseUrl);
    const repairCache = poisonedRepair.dimensionsCache || {};
    check(checks, "poisoned-cache-repaired", repairCache.repaired === true && repairCache.invalidEntries >= 3, `repaired=${repairCache.repaired}; invalid=${repairCache.invalidEntries}.`);
    check(checks, "poisoned-cache-pruned", repairCache.pruned >= 40 && repairCache.stale >= 1, `pruned=${repairCache.pruned}; stale=${repairCache.stale}.`);
    check(
      checks,
      "poisoned-cache-listed-images",
      imageEntries(poisonedRepair).length === count &&
        imageEntries(poisonedRepair).every((entry) => entry.dimensions?.width === 1 && entry.dimensions?.height === 1),
      `images=${imageEntries(poisonedRepair).length}/${count}.`
    );
    persistedAfterPoison = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    check(checks, "poisoned-cache-persisted-clean", Object.keys(persistedAfterPoison.entries || {}).length === count && !persistedAfterPoison.entries["bad-value"], `entries=${Object.keys(persistedAfterPoison.entries || {}).length}; seeded=${seededEntries}.`);

    warm = await listWithDimensions(baseUrl);
    const warmCache = warm.dimensionsCache || {};
    check(checks, "warm-cache-all-hits", warmCache.hits === count && warmCache.misses === 0 && warmCache.updates === 0, `hits=${warmCache.hits}; misses=${warmCache.misses}; updates=${warmCache.updates}.`);
    check(checks, "warm-cache-not-repaired", warmCache.repaired === false && warmCache.readError === null, `repaired=${warmCache.repaired}; readError=${warmCache.readError || "none"}.`);

    await fs.writeFile(cacheFile, "{ broken dimensions cache", "utf8");
    brokenJsonRepair = await listWithDimensions(baseUrl);
    const brokenCache = brokenJsonRepair.dimensionsCache || {};
    check(checks, "broken-json-cache-repaired", brokenCache.repaired === true && /json|unexpected|position|unterminated/i.test(String(brokenCache.readError || "")), `repaired=${brokenCache.repaired}; readError=${brokenCache.readError || "none"}.`);
    check(checks, "broken-json-cache-rebuilt", brokenCache.updates === count && brokenCache.entries === count, `updates=${brokenCache.updates}; entries=${brokenCache.entries}.`);
    persistedAfterBroken = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    check(checks, "broken-json-persisted-clean", persistedAfterBroken.version === 1 && Object.keys(persistedAfterBroken.entries || {}).length === count, `entries=${Object.keys(persistedAfterBroken.entries || {}).length}.`);

    const summary = {
      pass: checks.filter((item) => item.status === "pass").length,
      warn: checks.filter((item) => item.status === "warn").length,
      fail: checks.filter((item) => item.status === "fail").length
    };
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      runRoot,
      fixtureRoot,
      count,
      cacheFile,
      seededEntries,
      poisonedRepair: {
        returned: poisonedRepair.entries?.length || 0,
        dimensionsCache: poisonedRepair.dimensionsCache,
        timing: poisonedRepair.timing
      },
      warm: {
        returned: warm.entries?.length || 0,
        dimensionsCache: warm.dimensionsCache,
        timing: warm.timing
      },
      brokenJsonRepair: {
        returned: brokenJsonRepair.entries?.length || 0,
        dimensionsCache: brokenJsonRepair.dimensionsCache,
        timing: brokenJsonRepair.timing
      },
      persistedAfterPoison: {
        entries: Object.keys(persistedAfterPoison.entries || {}).length
      },
      persistedAfterBroken: {
        entries: Object.keys(persistedAfterBroken.entries || {}).length
      },
      checks,
      summary
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`metadata cache corruption: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (summary.fail > 0) {
      process.exitCode = 1;
    }
  } finally {
    await stopServer(server);
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
