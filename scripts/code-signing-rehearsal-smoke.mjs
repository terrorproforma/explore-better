import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `code-signing-${stamp}`);
const latestJsonPath = path.join(artifactsDir, "code-signing-rehearsal-latest.json");
const latestMdPath = path.join(artifactsDir, "code-signing-rehearsal-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_CODE_SIGNING_KEEP_FIXTURE === "1";
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

function statusCounts(checks) {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
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

function limitedAppend(current, chunk, limit = 32000) {
  const next = current + chunk.toString();
  return next.length <= limit ? next : next.slice(next.length - limit);
}

async function pathExists(itemPath) {
  try {
    await fs.access(itemPath);
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

async function fileRecord(filePath) {
  const stat = await fs.stat(filePath);
  return {
    path: filePath,
    relativePath: path.relative(workspace, filePath).replaceAll("\\", "/"),
    size: Number(stat.size) || 0,
    modifiedAt: stat.mtime.toISOString(),
    mtimeMs: Number(stat.mtimeMs) || 0,
    sha256: await hashFile(filePath)
  };
}

function runCommand(command, args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    let child = null;
    let stdout = "";
    let stderr = "";
    let settled = false;
    try {
      child = spawn(command, args, {
        cwd: workspace,
        env: process.env,
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

function parseJsonFromPowerShell(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return JSON.parse(text.slice(start, end + 1));
}

function signingScript() {
  return `param([string]$PayloadPath)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Payload = Get-Content -Raw -LiteralPath $PayloadPath | ConvertFrom-Json
$Result = [ordered]@{
  createdCertificate = $false
  removedCertificate = $false
  target = [string]$Payload.target
  subject = ""
  thumbprint = ""
  setStatus = ""
  verifyStatus = ""
  signerThumbprint = ""
  signerSubject = ""
  error = ""
}
$Cert = $null
try {
  $RunId = [string]$Payload.runId
  $Subject = "CN=Explore Better Rehearsal $RunId"
  $Result.subject = $Subject
  $Cert = New-SelfSignedCertificate -Subject $Subject -Type CodeSigningCert -CertStoreLocation "Cert:\\CurrentUser\\My" -KeyUsage DigitalSignature -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(2)
  $Result.createdCertificate = $true
  $Result.thumbprint = $Cert.Thumbprint
  $Signature = Set-AuthenticodeSignature -FilePath ([string]$Payload.target) -Certificate $Cert -HashAlgorithm SHA256
  $Result.setStatus = [string]$Signature.Status
  $Verify = Get-AuthenticodeSignature -FilePath ([string]$Payload.target)
  $Result.verifyStatus = [string]$Verify.Status
  if ($Verify.SignerCertificate) {
    $Result.signerThumbprint = [string]$Verify.SignerCertificate.Thumbprint
    $Result.signerSubject = [string]$Verify.SignerCertificate.Subject
  }
} catch {
  $Result.error = $_.Exception.Message
} finally {
  if ($Cert -and $Cert.Thumbprint) {
    Remove-Item -LiteralPath ("Cert:\\CurrentUser\\My\\" + $Cert.Thumbprint) -Force -ErrorAction SilentlyContinue
    $Result.removedCertificate = -not (Test-Path -LiteralPath ("Cert:\\CurrentUser\\My\\" + $Cert.Thumbprint))
  }
}
$Result | ConvertTo-Json -Compress -Depth 6
`;
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
    "# Explore Better Code-Signing Rehearsal",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Status: ${report.status}`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.fail} fail.`,
    "",
    "This verifier creates a temporary CurrentUser code-signing certificate, signs a copied setup installer, verifies signer metadata, then removes the temporary certificate. It does not replace the production certificate requirement.",
    "",
    "| Status | Check | Detail |",
    "| --- | --- | --- |"
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.status.toUpperCase()} | ${tableValue(check.label)} | ${tableValue(check.detail)} |`);
  }
  if (report.signing) {
    lines.push("", "## Signing Result", "");
    lines.push(`- Subject: ${report.signing.subject || "missing"}`);
    lines.push(`- Thumbprint: ${report.signing.thumbprint || "missing"}`);
    lines.push(`- Set status: ${report.signing.setStatus || "missing"}`);
    lines.push(`- Verify status: ${report.signing.verifyStatus || "missing"}`);
    lines.push(`- Certificate removed: ${report.signing.removedCertificate === true}`);
  }
  const failures = report.checks.filter((check) => check.status === "fail");
  if (failures.length) {
    lines.push("", "## Failures", "");
    for (const failure of failures) lines.push(`- ${failure.label}: ${failure.detail}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function readPackage() {
  const packagePath = path.join(workspace, "package.json");
  const text = await fs.readFile(packagePath, "utf8");
  return JSON.parse(text);
}

async function main() {
  const checks = [];
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(runRoot, { recursive: true });
  const pkg = await readPackage();
  const installerName = renderArtifactName(
    pkg.build?.nsis?.artifactName || pkg.build?.win?.artifactName || "ExploreBetter-${version}-${arch}-setup.${ext}",
    pkg,
    "exe"
  );
  const sourcePath = path.join(workspace, "dist", installerName);
  const sourcePresent = await pathExists(sourcePath);
  requireCheck(checks, sourcePresent, "installer-present", "Setup installer exists", sourcePresent ? sourcePath : `Missing ${sourcePath}; run npm run package:installer.`);

  let sourceBefore = null;
  let sourceAfter = null;
  let signedCopy = null;
  let signing = null;
  let powerShellResult = null;
  if (sourcePresent) {
    sourceBefore = await fileRecord(sourcePath);
    const targetPath = path.join(runRoot, installerName);
    await fs.copyFile(sourcePath, targetPath);
    signedCopy = await fileRecord(targetPath);
    requireCheck(
      checks,
      signedCopy.sha256 === sourceBefore.sha256 && signedCopy.size === sourceBefore.size,
      "copy-before-sign",
      "Installer copy matches source before signing",
      `${signedCopy.size} bytes`
    );

    const payloadPath = path.join(runRoot, "signing-payload.json");
    const scriptPath = path.join(runRoot, "signing-rehearsal.ps1");
    await fs.writeFile(payloadPath, JSON.stringify({ target: targetPath, runId: stamp }, null, 2), "utf8");
    await fs.writeFile(scriptPath, signingScript(), "utf8");
    powerShellResult = await runCommand("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-PayloadPath",
      payloadPath
    ]);
    signing = parseJsonFromPowerShell(powerShellResult.stdout);
    requireCheck(
      checks,
      powerShellResult.code === 0 && signing && !signing.error,
      "powershell-signing-run",
      "PowerShell signing rehearsal exits cleanly",
      signing?.error || powerShellResult.stderr || powerShellResult.error || `exit ${powerShellResult.code}`
    );

    signedCopy = await fileRecord(targetPath);
    sourceAfter = await fileRecord(sourcePath);
    requireCheck(
      checks,
      signing?.createdCertificate === true && /^[A-Fa-f0-9]{40}$/.test(signing?.thumbprint || ""),
      "temporary-cert-created",
      "Temporary CurrentUser code-signing certificate created",
      signing?.thumbprint || "missing"
    );
    requireCheck(
      checks,
      signing?.removedCertificate === true,
      "temporary-cert-removed",
      "Temporary code-signing certificate removed",
      signing?.thumbprint || "missing"
    );
    requireCheck(
      checks,
      signing?.signerThumbprint &&
        signing.signerThumbprint.toUpperCase() === String(signing.thumbprint || "").toUpperCase() &&
        signing?.verifyStatus !== "NotSigned",
      "signed-copy-verifies",
      "Signed installer copy exposes signer metadata",
      `set=${signing?.setStatus || "missing"}, verify=${signing?.verifyStatus || "missing"}`
    );
    requireCheck(
      checks,
      signedCopy.sha256 !== sourceBefore.sha256 && signedCopy.size >= sourceBefore.size,
      "signed-copy-mutated",
      "Signing mutates only the copied installer",
      `source=${sourceBefore.size} bytes, signed=${signedCopy.size} bytes`
    );
    requireCheck(
      checks,
      sourceAfter.sha256 === sourceBefore.sha256 && sourceAfter.size === sourceBefore.size,
      "source-installer-unchanged",
      "Original installer remains unchanged",
      sourceAfter.relativePath
    );
  }

  const summary = statusCounts(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    runRoot,
    status: summary.fail > 0 ? "fail" : "pass",
    package: {
      name: pkg.name,
      version: pkg.version,
      arch: buildArchName()
    },
    summary,
    checks,
    sourceBefore,
    sourceAfter,
    signedCopy,
    signing,
    powerShell: powerShellResult
      ? {
          code: powerShellResult.code,
          timedOut: powerShellResult.timedOut === true,
          stderr: String(powerShellResult.stderr || "").trim()
        }
      : null
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  if (!keepFixture()) {
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`code-signing rehearsal: ${summary.pass} pass, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail > 0) {
    const failures = checks.filter((check) => check.status === "fail");
    console.error(`failures: ${failures.map((check) => `${check.id}: ${check.detail}`).join("; ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
