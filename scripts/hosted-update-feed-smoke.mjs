import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const latestJsonPath = path.join(artifactsDir, "hosted-update-feed-latest.json");
const latestMdPath = path.join(artifactsDir, "hosted-update-feed-latest.md");
const requestTimeoutMs = Math.max(3000, Number(process.env.EB_HOSTED_FEED_TIMEOUT_MS || 15000));
const shouldHashAssets = process.argv.includes("--hash-assets") || process.env.EB_HOSTED_FEED_HASH_ASSETS === "1";
const allowLocalhostSmoke = process.argv.includes("--allow-localhost") || process.env.EB_HOSTED_FEED_ALLOW_LOCAL === "1";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function statusCounts(checks) {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length
  };
}

function addCheck(checks, status, id, label, detail = "", data = {}) {
  checks.push({ status, id, label, detail, ...data });
}

function requireCheck(checks, condition, id, label, detail = "", data = {}) {
  addCheck(checks, condition ? "pass" : "fail", id, label, detail, data);
  return Boolean(condition);
}

function warnCheck(checks, condition, id, label, detail = "", data = {}) {
  addCheck(checks, condition ? "pass" : "warn", id, label, detail, data);
  return Boolean(condition);
}

function slashPath(value) {
  return value.split(path.sep).join("/");
}

function relativePath(filePath) {
  return slashPath(path.relative(workspace, filePath));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

function configuredFeedUrl() {
  return optionValue("--url", process.env.EXPLORE_BETTER_UPDATE_URL || process.env.EB_UPDATE_URL || "").trim();
}

function normalizeFeedUrl(value) {
  const input = new URL(value);
  let latestUrl = input;
  let baseUrl = new URL(".", input);
  if (!input.pathname.toLowerCase().endsWith(".yml") && !input.pathname.toLowerCase().endsWith(".yaml")) {
    baseUrl = new URL(input.toString());
    if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname = `${baseUrl.pathname}/`;
    latestUrl = new URL("latest.yml", baseUrl);
  }
  return { latestUrl, baseUrl };
}

function isLocalhostName(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function stripYamlValue(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replaceAll("''", "'");
}

function parseLatestYml(text) {
  const parsed = { files: [] };
  let currentFile = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const fileUrlMatch = trimmed.match(/^-\s+url:\s*(.+)$/);
    if (fileUrlMatch) {
      currentFile = { url: stripYamlValue(fileUrlMatch[1]) };
      parsed.files.push(currentFile);
      continue;
    }
    const keyMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    const value = stripYamlValue(keyMatch[2]);
    if (key === "files" && !value) {
      currentFile = null;
      continue;
    }
    if (line.startsWith(" ") && currentFile) {
      currentFile[key] = /^\d+$/.test(value) ? Number(value) : value;
    } else {
      parsed[key] = /^\d+$/.test(value) ? Number(value) : value;
    }
  }
  return parsed;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, maxBytes = 1024 * 1024) {
  const response = await fetchWithTimeout(url, {
    headers: {
      accept: "application/x-yaml,text/yaml,text/plain,*/*"
    }
  });
  const chunks = [];
  let size = 0;
  if (!response.body) {
    const text = await response.text();
    return { response, text };
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`Response exceeded ${maxBytes} byte limit.`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return { response, text: Buffer.concat(chunks).toString("utf8") };
}

function headerObject(headers) {
  const data = {};
  for (const [key, value] of headers.entries()) data[key] = value;
  return data;
}

function contentRangeTotal(value) {
  const match = String(value || "").match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

async function probeAsset(url) {
  const head = await fetchWithTimeout(url, { method: "HEAD" }).catch((error) => ({ error }));
  if (head && !head.error && head.ok) {
    return {
      method: "HEAD",
      status: head.status,
      ok: true,
      size: Number(head.headers.get("content-length") || 0) || null,
      headers: headerObject(head.headers)
    };
  }
  const range = await fetchWithTimeout(url, { headers: { range: "bytes=0-0" } });
  const headers = headerObject(range.headers);
  const size = contentRangeTotal(range.headers.get("content-range")) || Number(range.headers.get("content-length") || 0) || null;
  await range.body?.cancel().catch(() => {});
  return {
    method: "GET range",
    status: range.status,
    ok: range.ok,
    size,
    headers,
    headError: head?.error?.message || null,
    headStatus: head?.status || null
  };
}

async function hashAsset(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let size = 0;
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    size = buffer.length;
    sha256.update(buffer);
    sha512.update(buffer);
  } else {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        const buffer = Buffer.from(value);
        sha256.update(buffer);
        sha512.update(buffer);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return { size, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
}

function artifactById(manifest, id) {
  return (Array.isArray(manifest?.artifacts) ? manifest.artifacts : []).find((artifact) => artifact.id === id);
}

function tableValue(value) {
  return String(value || "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

function markdownReport(report) {
  const lines = [
    "# Explore Better Hosted Update Feed",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Status: ${report.status}`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.`,
    "",
    `URL: ${report.feed?.latestUrl || "not configured"}`,
    "",
    "| Status | Check | Detail |",
    "| --- | --- | --- |"
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.status.toUpperCase()} | ${tableValue(check.label)} | ${tableValue(check.detail)} |`);
  }
  if (report.assets?.length) {
    lines.push("", "## Assets", "");
    lines.push("| Asset | URL | Size | Probe |");
    lines.push("| --- | --- | ---: | --- |");
    for (const asset of report.assets) {
      lines.push(`| ${tableValue(asset.id)} | ${tableValue(asset.url)} | ${asset.probe?.size || ""} | ${tableValue(asset.probe?.method)} ${asset.probe?.status || ""} |`);
    }
  }
  const warnings = report.checks.filter((check) => check.status === "warn");
  if (warnings.length) {
    lines.push("", "## Warnings", "");
    for (const warning of warnings) lines.push(`- ${warning.label}: ${warning.detail}`);
  }
  const failures = report.checks.filter((check) => check.status === "fail");
  if (failures.length) {
    lines.push("", "## Failures", "");
    for (const failure of failures) lines.push(`- ${failure.label}: ${failure.detail}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function writeReport(report) {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
}

async function main() {
  const checks = [];
  const assets = [];
  const packagePath = path.join(workspace, "package.json");
  const bundlePath = path.join(workspace, "dist", "release-bundle-manifest.json");
  const pkg = await readJson(packagePath);
  const rawUrl = configuredFeedUrl();
  if (!rawUrl) {
    addCheck(
      checks,
      "warn",
      "hosted-feed-url-configured",
      "Hosted update feed URL configured",
      "Set EXPLORE_BETTER_UPDATE_URL or EB_UPDATE_URL to verify the production-hosted generic update feed."
    );
    const summary = statusCounts(checks);
    const report = {
      generatedAt: new Date().toISOString(),
      workspace,
      status: "unconfigured",
      package: { name: pkg.name, version: pkg.version },
      summary,
      checks,
      feed: null,
      assets
    };
    await writeReport(report);
    console.log(`hosted update feed: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    return;
  }

  let normalized = null;
  try {
    normalized = normalizeFeedUrl(rawUrl);
    addCheck(checks, "pass", "hosted-feed-url-configured", "Hosted update feed URL configured", normalized.latestUrl.toString());
    warnCheck(
      checks,
      !isLocalhostName(normalized.latestUrl.hostname),
      "hosted-feed-production-host",
      "Hosted feed host is production-like",
      isLocalhostName(normalized.latestUrl.hostname)
        ? allowLocalhostSmoke
          ? "Localhost feed accepted for smoke testing only; production still needs a non-local hosted URL."
          : "Localhost is not a production-hosted update feed."
        : normalized.latestUrl.hostname
    );
  } catch (error) {
    addCheck(checks, "fail", "hosted-feed-url-valid", "Hosted update feed URL is valid", error.message);
  }

  const bundleExists = await pathExists(bundlePath);
  requireCheck(
    checks,
    bundleExists,
    "release-bundle-present",
    "Local release bundle manifest exists",
    bundleExists ? relativePath(bundlePath) : "Run npm run verify:release-bundle before hosted feed verification."
  );
  const bundle = bundleExists ? await readJson(bundlePath) : null;
  const installer = artifactById(bundle, "setup-installer");
  const blockmap = artifactById(bundle, "setup-blockmap");
  const expectedInstallerName = installer?.relativePath?.split("/").pop() || "";
  const expectedBlockmapName = blockmap?.relativePath?.split("/").pop() || "";
  requireCheck(
    checks,
    Boolean(installer?.sha512 && installer?.size && blockmap?.size),
    "release-bundle-artifacts",
    "Local bundle has installer and blockmap metadata",
    installer && blockmap ? `${expectedInstallerName}, ${expectedBlockmapName}` : "Missing setup-installer or setup-blockmap in release bundle."
  );

  let latestText = "";
  let latestParsed = null;
  if (normalized) {
    try {
      const fetched = await fetchText(normalized.latestUrl.toString());
      latestText = fetched.text;
      requireCheck(
        checks,
        fetched.response.ok,
        "hosted-latest-fetch",
        "Hosted latest.yml is reachable",
        `HTTP ${fetched.response.status}, ${latestText.length} bytes.`,
        { headers: headerObject(fetched.response.headers) }
      );
      latestParsed = parseLatestYml(latestText);
    } catch (error) {
      addCheck(checks, "fail", "hosted-latest-fetch", "Hosted latest.yml is reachable", error.message);
    }
  }

  const firstFile = latestParsed?.files?.[0] || {};
  const hostedInstallerName = firstFile.url || latestParsed?.path || "";
  const latestMatches =
    latestParsed?.version === pkg.version &&
    latestParsed?.path === expectedInstallerName &&
    hostedInstallerName === expectedInstallerName &&
    latestParsed?.sha512 === installer?.sha512 &&
    firstFile.sha512 === installer?.sha512 &&
    Number(firstFile.size || 0) === Number(installer?.size || -1) &&
    Number(firstFile.blockMapSize || 0) === Number(blockmap?.size || -1);
  if (latestParsed) {
    requireCheck(
      checks,
      latestMatches,
      "hosted-latest-matches-bundle",
      "Hosted latest.yml matches local release bundle",
      latestMatches
        ? `${pkg.version} -> ${expectedInstallerName}, ${installer.size} bytes.`
        : `version=${latestParsed.version}, path=${latestParsed.path}, file=${hostedInstallerName}, size=${firstFile.size}, blockMapSize=${firstFile.blockMapSize}.`
    );
  }

  if (normalized && installer && blockmap && expectedInstallerName) {
    const expectedAssets = [
      { id: "setup-installer", name: expectedInstallerName, expected: installer },
      { id: "setup-blockmap", name: expectedBlockmapName, expected: blockmap }
    ];
    for (const asset of expectedAssets) {
      const url = new URL(asset.name, normalized.baseUrl).toString();
      try {
        const probe = await probeAsset(url);
        const sizeMatches = Number(probe.size || 0) === Number(asset.expected.size || -1);
        requireCheck(
          checks,
          probe.ok && sizeMatches,
          `hosted-${asset.id}-reachable`,
          `Hosted ${asset.id} is reachable and sized correctly`,
          probe.ok && sizeMatches
            ? `${probe.method} HTTP ${probe.status}, ${probe.size} bytes.`
            : `${probe.method} HTTP ${probe.status}, size=${probe.size || "unknown"}, expected=${asset.expected.size}.`,
          { url, probe }
        );
        const record = { id: asset.id, url, probe };
        if (shouldHashAssets) {
          const hashed = await hashAsset(url);
          const hashMatches =
            Number(hashed.size || 0) === Number(asset.expected.size || -1) &&
            hashed.sha256 === asset.expected.sha256 &&
            hashed.sha512 === asset.expected.sha512;
          requireCheck(
            checks,
            hashMatches,
            `hosted-${asset.id}-hash`,
            `Hosted ${asset.id} full hash matches bundle`,
            hashMatches ? `${hashed.size} bytes; sha256=${hashed.sha256.slice(0, 16)}...` : "Downloaded asset hash did not match the bundle.",
            { url }
          );
          record.hash = hashed;
        } else {
          warnCheck(
            checks,
            true,
            `hosted-${asset.id}-full-hash-optional`,
            `Hosted ${asset.id} full hash optional`,
            "Use EB_HOSTED_FEED_HASH_ASSETS=1 or --hash-assets to download and hash this hosted asset."
          );
        }
        assets.push(record);
      } catch (error) {
        addCheck(checks, "fail", `hosted-${asset.id}-reachable`, `Hosted ${asset.id} is reachable and sized correctly`, error.message, { url });
      }
    }
  }

  const summary = statusCounts(checks);
  const status = summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "pass";
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    status,
    package: { name: pkg.name, version: pkg.version },
    summary,
    checks,
    feed: normalized
      ? {
          configuredUrl: rawUrl,
          latestUrl: normalized.latestUrl.toString(),
          baseUrl: normalized.baseUrl.toString(),
          parsed: latestParsed,
          latestText
        }
      : null,
    localBundle: bundlePath,
    assets,
    fullHashAssets: shouldHashAssets
  };
  await writeReport(report);
  console.log(`hosted update feed: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail > 0) {
    const failures = checks.filter((check) => check.status === "fail");
    console.error(`failures: ${failures.map((check) => `${check.id}: ${check.detail}`).join("; ")}`);
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  const checks = [
    {
      status: "fail",
      id: "hosted-update-feed-error",
      label: "Hosted update feed verifier crashed",
      detail: error.stack || error.message
    }
  ];
  const summary = statusCounts(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    status: "fail",
    summary,
    checks,
    feed: null,
    assets: []
  };
  await writeReport(report).catch(() => {});
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
