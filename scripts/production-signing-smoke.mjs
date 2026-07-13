import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const latestJsonPath = path.join(artifactsDir, "production-signing-latest.json");
const latestMdPath = path.join(artifactsDir, "production-signing-latest.md");
const timeoutMs = Math.max(15000, Number(process.env.EB_PRODUCTION_SIGNING_TIMEOUT_MS || 60000));

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function configuredThumbprint() {
  return optionValue("--thumbprint", process.env.EXPLORE_BETTER_SIGNING_THUMBPRINT || process.env.EB_SIGNING_THUMBPRINT || "").trim();
}

function configuredSubject() {
  return optionValue("--subject", process.env.EXPLORE_BETTER_SIGNING_SUBJECT || process.env.EB_SIGNING_SUBJECT || "").trim();
}

function allowUntrusted() {
  return (
    process.argv.includes("--allow-untrusted") ||
    process.env.EXPLORE_BETTER_SIGNING_ALLOW_UNTRUSTED === "1" ||
    process.env.EB_SIGNING_ALLOW_UNTRUSTED === "1"
  );
}

function buildArchName() {
  if (process.arch === "x64") return "x64";
  if (process.arch === "ia32") return "ia32";
  if (process.arch === "arm64") return "arm64";
  return process.arch;
}

function renderArtifactName(template, pkg, ext) {
  return String(template || "")
    .replaceAll("${productName}", pkg.build?.productName || pkg.productName || pkg.name || "ExploreBetter")
    .replaceAll("${name}", pkg.name || "explore-better")
    .replaceAll("${version}", pkg.version || "0.0.0")
    .replaceAll("${arch}", buildArchName())
    .replaceAll("${ext}", ext);
}

function slashPath(value) {
  return value.split(path.sep).join("/");
}

function relativePath(filePath) {
  return slashPath(path.relative(workspace, filePath));
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

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function fileRecord(filePath, id, label) {
  const stat = await fs.stat(filePath);
  return {
    id,
    label,
    path: filePath,
    relativePath: relativePath(filePath),
    size: Number(stat.size) || 0,
    mtimeMs: Number(stat.mtimeMs) || 0,
    modifiedAt: stat.mtime.toISOString(),
    sha256: await hashFile(filePath)
  };
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

function limitedAppend(current, chunk, limit = 64000) {
  const next = current + chunk.toString();
  return next.length <= limit ? next : next.slice(next.length - limit);
}

function runPowerShell(script, env = {}) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const childEnv = { ...process.env, ...env };
    const executable =
      process.platform === "win32"
        ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        : "pwsh";
    if (process.platform === "win32") delete childEnv.PSModulePath;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child = null;
    try {
      child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
        cwd: workspace,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      resolve({ code: null, error: error.message, stdout, stderr });
      return;
    }
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: null, timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = limitedAppend(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = limitedAppend(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code: null, error: error.message, stdout, stderr });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function signatureScript() {
  return `$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Payload = Get-Content -Raw -LiteralPath $env:EB_PRODUCTION_SIGNING_PAYLOAD | ConvertFrom-Json
$Results = @()
foreach ($Target in $Payload.targets) {
  $Path = [string]$Target.path
  $Item = [ordered]@{
    id = [string]$Target.id
    path = $Path
    exists = $false
    status = ""
    statusMessage = ""
    signerSubject = ""
    signerThumbprint = ""
    issuer = ""
    notBefore = ""
    notAfter = ""
    serialNumber = ""
  }
  if (Test-Path -LiteralPath $Path) {
    $Item.exists = $true
    $Sig = Get-AuthenticodeSignature -FilePath $Path
    $Item.status = [string]$Sig.Status
    $Item.statusMessage = [string]$Sig.StatusMessage
    if ($Sig.SignerCertificate) {
      $Item.signerSubject = [string]$Sig.SignerCertificate.Subject
      $Item.signerThumbprint = [string]$Sig.SignerCertificate.Thumbprint
      $Item.issuer = [string]$Sig.SignerCertificate.Issuer
      $Item.notBefore = $Sig.SignerCertificate.NotBefore.ToUniversalTime().ToString("o")
      $Item.notAfter = $Sig.SignerCertificate.NotAfter.ToUniversalTime().ToString("o")
      $Item.serialNumber = [string]$Sig.SignerCertificate.SerialNumber
    }
  }
  $Results += [pscustomobject]$Item
}
$Results | ConvertTo-Json -Compress -Depth 6
`;
}

function parsePowerShellJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return [];
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) return JSON.parse(text.slice(arrayStart, arrayEnd + 1));
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) return [JSON.parse(text.slice(objectStart, objectEnd + 1))];
  return [];
}

function signatureById(signatures, id) {
  return signatures.find((entry) => entry.id === id);
}

function normalizeThumbprint(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function signerMatches(signature, expectedThumbprint, expectedSubject) {
  const signerThumbprint = normalizeThumbprint(signature?.signerThumbprint);
  const wantedThumbprint = normalizeThumbprint(expectedThumbprint);
  const subject = String(signature?.signerSubject || "").toLowerCase();
  const wantedSubject = String(expectedSubject || "").toLowerCase();
  const thumbprintOk = !wantedThumbprint || signerThumbprint === wantedThumbprint;
  const subjectOk = !wantedSubject || subject.includes(wantedSubject);
  return thumbprintOk && subjectOk;
}

function artifactFromBundle(bundle, id) {
  return (Array.isArray(bundle?.artifacts) ? bundle.artifacts : []).find((artifact) => artifact.id === id);
}

function tableValue(value) {
  return String(value || "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

function markdownReport(report) {
  const lines = [
    "# Explore Better Production Signing",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Status: ${report.status}`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.`,
    "",
    "| Status | Check | Detail |",
    "| --- | --- | --- |"
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.status.toUpperCase()} | ${tableValue(check.label)} | ${tableValue(check.detail)} |`);
  }
  lines.push("", "## Signatures", "");
  lines.push("| Artifact | Status | Subject | Thumbprint |");
  lines.push("| --- | --- | --- | --- |");
  for (const signature of report.signatures || []) {
    lines.push(
      `| ${tableValue(signature.id)} | ${tableValue(signature.status)} | ${tableValue(signature.signerSubject)} | ${tableValue(signature.signerThumbprint)} |`
    );
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
  const pkg = await readJson(path.join(workspace, "package.json"));
  addCheck(checks, "pass", "pkg-readable", "package.json readable", `${pkg.name}@${pkg.version}`);

  const installerName = renderArtifactName(
    pkg.build?.nsis?.artifactName || pkg.build?.win?.artifactName || "ExploreBetter-${version}-${arch}-setup.${ext}",
    pkg,
    "exe"
  );
  const unpackedExeName = process.platform === "win32" ? "Explore Better.exe" : "Explore Better";
  const targets = [
    {
      id: "setup-installer",
      label: "NSIS setup installer",
      path: path.join(workspace, "dist", installerName)
    },
    {
      id: "unpacked-exe",
      label: "Unpacked desktop executable",
      path: path.join(workspace, "dist", "win-unpacked", unpackedExeName)
    },
    {
      id: "native-helper",
      label: "Packaged native filesystem helper",
      path: path.join(workspace, "dist", "win-unpacked", "resources", "native", "explore-better-fs.exe")
    }
  ];
  const files = [];
  const missing = [];
  for (const target of targets) {
    if (await pathExists(target.path)) {
      files.push(await fileRecord(target.path, target.id, target.label));
    } else {
      missing.push(target);
    }
  }
  requireCheck(
    checks,
    missing.length === 0,
    "signing-targets-present",
    "Production signing targets exist",
    missing.length ? `Missing ${missing.map((target) => relativePath(target.path)).join(", ")}.` : `${files.length} target(s) found.`
  );

  const bundlePath = path.join(workspace, "dist", "release-bundle-manifest.json");
  let bundle = null;
  if (await pathExists(bundlePath)) {
    bundle = await readJson(bundlePath);
    addCheck(checks, "pass", "release-bundle-present", "Release bundle manifest exists", relativePath(bundlePath));
  } else {
    addCheck(checks, "warn", "release-bundle-present", "Release bundle manifest exists", "Run npm run verify:release-bundle to compare signing targets to the release bundle.");
  }
  const bundleMismatches = [];
  for (const file of files) {
    const artifact = artifactFromBundle(bundle, file.id);
    if (artifact && artifact.sha256 !== file.sha256) bundleMismatches.push(file.id);
  }
  if (bundle) {
    const bundleGeneratedAt = Date.parse(bundle.generatedAt || "");
    const bundleIsStale = Number.isFinite(bundleGeneratedAt) && files.some((file) => file.mtimeMs > bundleGeneratedAt + 1000);
    if (bundleIsStale) {
      addCheck(
        checks,
        "warn",
        "signing-targets-match-bundle",
        "Signing targets match the current release bundle",
        "The existing release bundle predates the current packaged binaries; regenerate it before publishing."
      );
    } else {
      requireCheck(
        checks,
        bundleMismatches.length === 0,
        "signing-targets-match-bundle",
        "Signing targets match the current release bundle",
        bundleMismatches.length ? `Hash mismatch for ${bundleMismatches.join(", ")}.` : `${files.length} target hash(es) match.`
      );
    }
  }

  const payloadPath = path.join(artifactsDir, "production-signing-payload.json");
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(payloadPath, JSON.stringify({ targets: files.map((file) => ({ id: file.id, path: file.path })) }, null, 2), "utf8");
  const psResult = await runPowerShell(signatureScript(), { EB_PRODUCTION_SIGNING_PAYLOAD: payloadPath });
  const signatures = parsePowerShellJson(psResult.stdout);
  requireCheck(
    checks,
    psResult.code === 0 && signatures.length === files.length,
    "authenticode-inspection",
    "Authenticode signatures inspected",
    psResult.code === 0 && signatures.length === files.length
      ? `${signatures.length} signature record(s).`
      : psResult.error || psResult.stderr || `exit=${psResult.code}, records=${signatures.length}`
  );

  const expectedThumbprint = configuredThumbprint();
  const expectedSubject = configuredSubject();
  const expectationConfigured = Boolean(expectedThumbprint || expectedSubject);
  warnCheck(
    checks,
    expectationConfigured,
    "production-signing-configured",
    "Production signing certificate expectation configured",
    expectationConfigured
      ? `${expectedThumbprint ? `thumbprint=${expectedThumbprint}` : ""}${expectedThumbprint && expectedSubject ? ", " : ""}${expectedSubject ? `subject contains ${expectedSubject}` : ""}`
      : "Set EXPLORE_BETTER_SIGNING_THUMBPRINT or EXPLORE_BETTER_SIGNING_SUBJECT to make this verifier strict."
  );

  for (const file of files) {
    const signature = signatureById(signatures, file.id);
    const signed = Boolean(signature?.signerThumbprint && signature.status !== "NotSigned");
    if (expectationConfigured) {
      requireCheck(
        checks,
        signed,
        `${file.id}-signed`,
        `${file.label} is Authenticode-signed`,
        signed ? `status=${signature.status}, signer=${signature.signerSubject}` : `status=${signature?.status || "missing"}`
      );
      requireCheck(
        checks,
        signed && signerMatches(signature, expectedThumbprint, expectedSubject),
        `${file.id}-signer-matches`,
        `${file.label} signer matches expected production certificate`,
        signed
          ? `thumbprint=${signature.signerThumbprint}, subject=${signature.signerSubject}`
          : "No signer certificate."
      );
      if (!allowUntrusted()) {
        requireCheck(
          checks,
          signature?.status === "Valid",
          `${file.id}-signature-valid`,
          `${file.label} signature chain is trusted`,
          `status=${signature?.status || "missing"}${signature?.statusMessage ? `, ${signature.statusMessage}` : ""}`
        );
      } else {
        addCheck(checks, "warn", `${file.id}-signature-valid`, `${file.label} signature chain trust skipped`, "Skipped by --allow-untrusted or EB_SIGNING_ALLOW_UNTRUSTED=1.");
      }
    } else {
      warnCheck(
        checks,
        signed,
        `${file.id}-signed-observed`,
        `${file.label} has an observed Authenticode signature`,
        signed
          ? `status=${signature.status}, signer=${signature.signerSubject}`
          : `status=${signature?.status || "missing"}; production release still needs a real signing certificate.`
      );
    }
  }

  await fs.rm(payloadPath, { force: true }).catch(() => {});

  const summary = statusCounts(checks);
  const status = summary.fail > 0 ? "fail" : expectationConfigured && summary.warn === 0 ? "pass" : "warn";
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    status,
    package: {
      name: pkg.name,
      version: pkg.version,
      arch: buildArchName()
    },
    summary,
    checks,
    expected: {
      configured: expectationConfigured,
      thumbprint: expectedThumbprint || null,
      subject: expectedSubject || null,
      requireTrustedChain: expectationConfigured && !allowUntrusted()
    },
    files,
    signatures,
    powerShell: {
      code: psResult.code,
      timedOut: psResult.timedOut === true,
      stderr: String(psResult.stderr || "").trim(),
      error: psResult.error || null
    },
    releaseBundlePath: bundle ? relativePath(bundlePath) : null
  };
  await writeReport(report);
  console.log(`production signing: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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
      id: "production-signing-error",
      label: "Production signing verifier crashed",
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
    files: [],
    signatures: []
  };
  await writeReport(report).catch(() => {});
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
