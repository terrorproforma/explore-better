import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseRepository, sha256, verifyPublishedMcpRelease } from "./mcp-release-metadata.mjs";

const require = createRequire(import.meta.url);
const { ZipFile } = require("yazl");
const yaml = require("js-yaml");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = "1.2.3";
const tag = `v${version}`;
const artifactName = `ExploreBetter-MCP-${version}-windows-x64.mcpb`;
const manifest = Buffer.from(`${JSON.stringify({ name: "explore-better", version, manifest_version: "0.3" }, null, 2)}\n`);
const sidecar = Buffer.from("Isolated release fixture binary bytes.\n");
const zip = new ZipFile();
const chunks = [];
const complete = new Promise((resolve, reject) => {
  zip.outputStream.on("data", (chunk) => chunks.push(chunk));
  zip.outputStream.on("error", reject);
  zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
});
zip.addBuffer(manifest, "manifest.json");
zip.addBuffer(sidecar, "server/ExploreBetterMcp.exe");
zip.end();
const artifact = await complete;
const checksums = Buffer.from(`${sha256(artifact)}  ${artifactName}\n${sha256(sidecar)}  ExploreBetterMcp.exe\n${sha256(manifest)}  manifest.json\n`);
function releaseFor(files) {
  return {
    id: 123, tag_name: tag, draft: false, published_at: "2026-09-09T00:00:00Z",
    html_url: `https://github.com/${releaseRepository}/releases/tag/${tag}`,
    assets: Object.entries(files).map(([name, bytes]) => ({
      name, state: "uploaded", size: bytes.length, digest: `sha256:${sha256(bytes)}`,
      browser_download_url: `https://github.com/${releaseRepository}/releases/download/${tag}/${name}`
    }))
  };
}
const files = { [artifactName]: artifact, "manifest.json": manifest, "SHA256SUMS-mcp.txt": checksums };
const input = { tag, packageVersion: version, artifact, manifest, checksums, release: releaseFor(files) };
const verified = await verifyPublishedMcpRelease(input);
assert.equal(verified.server.version, version);
assert.equal(verified.server.packages[0].fileSha256, sha256(artifact));
assert.equal(verified.server.packages[0].identifier, `https://github.com/${releaseRepository}/releases/download/${tag}/${artifactName}`);
assert(verified.server.description.length <= 100);
await assert.rejects(verifyPublishedMcpRelease({ ...input, packageVersion: "1.2.4" }), /exactly match/);
await assert.rejects(verifyPublishedMcpRelease({ ...input, release: { ...input.release, tag_name: "v1.2.4" } }), /matching tag/);
await assert.rejects(verifyPublishedMcpRelease({ ...input, release: { ...input.release, draft: true } }), /already-published/);
await assert.rejects(verifyPublishedMcpRelease({ ...input, release: { ...input.release, published_at: null } }), /already-published/);
await assert.rejects(verifyPublishedMcpRelease({ ...input, release: { ...input.release, assets: input.release.assets.slice(1) } }), /exactly one/);
await assert.rejects(verifyPublishedMcpRelease({ ...input, release: { ...input.release, assets: [...input.release.assets, input.release.assets[0]] } }), /exactly one/);
const altered = Buffer.from(artifact); altered[0] ^= 1;
await assert.rejects(verifyPublishedMcpRelease({ ...input, artifact: altered, release: releaseFor({ ...files, [artifactName]: altered }) }), /release checksum/);
const otherManifest = Buffer.from(`${JSON.stringify({ name: "explore-better", version, description: "Different metadata" })}\n`);
await assert.rejects(verifyPublishedMcpRelease({ ...input, manifest: otherManifest, release: releaseFor({ ...files, "manifest.json": otherManifest }) }), /differs from the manifest inside/);
const wrongSidecar = Buffer.from(checksums.toString().replace(sha256(sidecar), "0".repeat(64)));
await assert.rejects(verifyPublishedMcpRelease({ ...input, checksums: wrongSidecar, release: releaseFor({ ...files, "SHA256SUMS-mcp.txt": wrongSidecar }) }), /sidecar inside/);
const wrongManifest = Buffer.from(checksums.toString().replace(sha256(manifest), "0".repeat(64)));
await assert.rejects(verifyPublishedMcpRelease({ ...input, checksums: wrongManifest, release: releaseFor({ ...files, "SHA256SUMS-mcp.txt": wrongManifest }) }), /manifest checksum/);
const legacy = Buffer.from(checksums.toString().split("\n").slice(0, 2).join("\n") + "\n");
await verifyPublishedMcpRelease({ ...input, checksums: legacy, release: releaseFor({ ...files, "SHA256SUMS-mcp.txt": legacy }) });

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "eb-mcp-release-"));
try {
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(temp, name), bytes);
  await fs.writeFile(path.join(temp, "release.json"), JSON.stringify(input.release));
  await fs.writeFile(path.join(temp, "package.json"), JSON.stringify({ version }));
  const prepared = spawnSync(process.execPath, [path.join(root, "scripts", "prepare-mcp-registry.mjs"), `--tag=${tag}`, `--repository=${releaseRepository}`, `--assets=${temp}`, `--release=${path.join(temp, "release.json")}`, `--package=${path.join(temp, "package.json")}`, `--output=${path.join(temp, "registry")}`], { windowsHide: true, encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  const server = JSON.parse(await fs.readFile(path.join(temp, "registry", "server.json"), "utf8"));
  assert.deepEqual(server, verified.server);
  for (const [name, bytes] of Object.entries(files)) assert((await fs.readFile(path.join(temp, name))).equals(bytes), "Preparing Registry metadata must leave published asset bytes unchanged.");
} finally {
  const resolved = path.resolve(temp);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("eb-mcp-release-"));
  await fs.rm(resolved, { recursive: true, force: true });
}
const workflowText = await fs.readFile(path.join(root, ".github", "workflows", "publish-mcp.yml"), "utf8");
const workflow = yaml.load(workflowText);
assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
assert.equal(workflow.permissions.contents, "read");
assert(!/gh release upload|--clobber|npm run build:mcpb/.test(workflowText), "Registry publication must consume immutable release assets.");
assert(workflow.jobs.publish.steps.some((step) => step.with?.path === "release-source" && step.with.ref.startsWith("refs/tags/")), "The package version must come from the explicitly selected tag.");
const publisherInstall = workflow.jobs.publish.steps.find((step) => step.name === "Install the official MCP Registry publisher");
assert.equal(publisherInstall.shell, "bash");
assert.match(publisherInstall.run, /^set -euo pipefail\s/);

const releaseWorkflowText = await fs.readFile(path.join(root, ".github", "workflows", "release.yml"), "utf8");
const releaseWorkflow = yaml.load(releaseWorkflowText);
assert(!releaseWorkflowText.includes("--clobber"), "Release uploads must never overwrite existing assets, including during a publication race.");
// Only the publish job may hold a repository write token; the build job (npm ci, packaging) stays read-only.
assert.equal(releaseWorkflow.jobs.build.permissions?.contents, "read", "The release build job must not receive a repository write token.");
assert.equal(releaseWorkflow.jobs.publish.permissions?.contents, "write");
const protection = releaseWorkflow.jobs.publish.steps.find((step) => step.name === "Protect published release assets");
const upload = releaseWorkflow.jobs.publish.steps.find((step) => step.name === "Create or update draft GitHub release");
assert.equal(protection.shell, "pwsh");
assert.equal(upload.shell, "pwsh");

// Optional Authenticode signing (docs/CODE_SIGNING.md). Exactly one build job runs: the
// unsigned one never holds an OIDC token; the tag-only signed one requests Azure
// credentials only after npm ci and the pre-packaging build, and drops them straight
// after electron-builder has signed and packaged.
const unsignedBuild = releaseWorkflow.jobs.build;
const signedBuild = releaseWorkflow.jobs["build-signed"];
assert.deepEqual(unsignedBuild.permissions, { contents: "read" }, "The unsigned build must not be able to request an OIDC token.");
assert.deepEqual(signedBuild.permissions, { contents: "read", "id-token": "write" });
assert.equal(signedBuild.environment, "release-signing", "Azure must trust only the tag-restricted signing environment.");
assert.match(signedBuild.if, /^startsWith\(github\.ref, 'refs\/tags\/'\) && \(vars\.AZURE_SIGNING_ENDPOINT != '' \|\| /);
assert.equal(unsignedBuild.if, `\${{ !(${signedBuild.if}) }}`, "The unsigned and signed build gates must be exact complements.");
assert(!/\$\{\{\s*secrets\./.test(releaseWorkflowText), "Signing uses OIDC and repository variables; the release workflow needs no secrets.");
const signedSteps = signedBuild.steps;
const stepIndex = (predicate, label) => {
  const index = signedSteps.findIndex(predicate);
  assert(index >= 0, `Signed build is missing: ${label}`);
  return index;
};
const loginIndex = stepIndex((step) => step.uses?.startsWith("azure/login@"), "azure/login");
const signOutIndex = stepIndex((step) => step.name === "Sign out of Azure", "Azure sign-out");
const metadataIndex = stepIndex((step) => step.name === "Build update metadata from the signed output", "release metadata");
const strictIndex = stepIndex((step) => step.name === "Require trusted, timestamped Authenticode signatures", "strict signature verification");
assert.deepEqual(Object.keys(signedSteps[loginIndex].with).sort(), ["client-id", "subscription-id", "tenant-id"], "azure/login must use OIDC without a client secret.");
assert.deepEqual(signedSteps.slice(loginIndex + 1, signOutIndex).map((step) => step.name), ["Obtain the Artifact Signing access token", "Package and sign installer"]);
assert.equal(signedSteps[signOutIndex].if, "always()");
signedSteps.forEach((step, index) => {
  if (/\bnpm (ci|install|audit)\b|prepackage/.test(step.run || "")) assert(index < loginIndex, `${step.name || step.run} must finish before Azure sign-in.`);
});
assert(signOutIndex < metadataIndex && metadataIndex < strictIndex, "Signatures are verified after every release file exists.");
assert.equal(signedSteps[strictIndex].env?.EXPLORE_BETTER_SIGNING_SUBJECT, "${{ vars.AZURE_SIGNING_PUBLISHER_NAME }}", "Signed releases must verify strictly.");
assert.equal(signedSteps[metadataIndex].env?.EXPLORE_BETTER_MCPB_SIDECAR, "dist/win-unpacked/resources/native/ExploreBetterMcp.exe");
const packageStep = signedSteps[loginIndex + 2];
assert.match(packageStep.run, /^node scripts\/run-electron-builder\.mjs --win nsis\s/);
for (const name of ["ENDPOINT", "ACCOUNT", "PROFILE", "PUBLISHER_NAME"]) {
  assert.equal(packageStep.env[`EXPLORE_BETTER_AZURE_SIGNING_${name}`], `\${{ vars.AZURE_SIGNING_${name} }}`);
}
const unsignedRecord = unsignedBuild.steps.find((step) => step.name === "Record current Authenticode status");
assert(unsignedRecord && !unsignedRecord.env, "Unsigned builds keep the warn-only Authenticode record.");
const releaseStepList = (step) => [...step.run.match(/\$releaseSteps = @\(([^)]*)\)/)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
const unsignedList = releaseStepList(unsignedBuild.steps.find((step) => step.name === "Build installer and update metadata"));
assert.equal(unsignedList[0], "package:installer");
assert.deepEqual(releaseStepList(signedSteps[metadataIndex]), unsignedList.slice(1), "Signed and unsigned builds must run the same release steps.");
const uploadInputs = (job) => job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@")).with;
assert.deepEqual(uploadInputs(signedBuild), uploadInputs(unsignedBuild), "Both builds must hand publish the same artifact.");
const setupSteps = (job) => job.steps.filter((step) => step.uses?.startsWith("actions/") && !step.uses.startsWith("actions/upload-artifact@"));
assert.deepEqual(setupSteps(signedBuild), setupSteps(unsignedBuild));
assert.deepEqual(releaseWorkflow.jobs.publish.needs, ["build", "build-signed"]);
assert.equal(releaseWorkflow.jobs.publish.if, "${{ !cancelled() && startsWith(github.ref, 'refs/tags/') && contains(needs.*.result, 'success') && !contains(needs.*.result, 'failure') }}");

// Execute the actual workflow blocks with local function stubs. These fixtures cannot
// contact GitHub or publish anything; the only files created are under the temp root.
const workflowTemp = await fs.mkdtemp(path.join(os.tmpdir(), "eb-release-workflow-"));
let workflowCases = 0;
try {
  await fs.mkdir(path.join(workflowTemp, "dist", "mcp"), { recursive: true });
  for (const name of ["dist/ExploreBetter-1.2.3-x64-setup.exe", "dist/ExploreBetter-1.2.3-x64-setup.exe.blockmap", `dist/mcp/${artifactName}`]) {
    await fs.writeFile(path.join(workflowTemp, name), "Ordinary isolated fixture bytes.\n");
  }
  const releaseResponse = (draft, extra = {}) => ({ status: 200, content: JSON.stringify({ tag_name: tag, draft, ...extra }) });
  // The tag endpoint only returns published releases, so drafts are found by listing.
  const listResponse = (...releases) => ({ status: 200, list: true, content: JSON.stringify(releases.map((draft) => ({ tag_name: tag, draft }))) });
  const cases = [
    { name: "guard-missing", step: protection, responses: [{ status: 404 }], calls: ["http:404"] },
    { name: "guard-draft", step: protection, responses: [releaseResponse(true)], calls: ["http:200"] },
    { name: "guard-public", step: protection, responses: [releaseResponse(false)], calls: ["http:200"], error: "already published" },
    { name: "guard-forbidden", step: protection, responses: [{ status: 403 }], calls: ["http:403"], error: "HTTP 403" },
    { name: "guard-unavailable", step: protection, responses: [{ status: 503 }], calls: ["http:503"], error: "HTTP 503" },
    { name: "guard-transport", step: protection, responses: [{ transportError: true }], calls: ["http:transport"], error: "Fixture transport failure" },
    { name: "guard-wrong-tag", step: protection, responses: [releaseResponse(true, { tag_name: "v9.9.9" })], calls: ["http:200"], error: "invalid or mismatched" },
    { name: "guard-invalid-draft", step: protection, responses: [releaseResponse("true")], calls: ["http:200"], error: "invalid or mismatched" },
    { name: "create-draft", step: upload, responses: [{ status: 404 }, listResponse(), { status: 404 }, listResponse(true)], calls: ["http:404", "list:200", "create", "http:404", "list:200", "upload"] },
    { name: "create-fails", step: upload, responses: [{ status: 404 }, listResponse()], createExit: 1, calls: ["http:404", "list:200", "create"], error: "Could not create draft" },
    { name: "list-fails", step: upload, responses: [{ status: 404 }, { status: 500, list: true }], calls: ["http:404", "list:500"], error: "Release listing failed" },
    { name: "duplicate-drafts", step: upload, responses: [{ status: 404 }, listResponse(true, true)], calls: ["http:404", "list:200"], error: "Multiple draft releases" },
    { name: "existing-draft-listed", step: upload, responses: [{ status: 404 }, listResponse(false, true)], calls: ["http:404", "list:200", "upload"] },
    { name: "upload-forbidden", step: upload, responses: [{ status: 403 }], calls: ["http:403"], error: "HTTP 403" },
    { name: "upload-unavailable", step: upload, responses: [{ status: 503 }], calls: ["http:503"], error: "HTTP 503" },
    { name: "upload-public", step: upload, responses: [releaseResponse(false)], calls: ["http:200"], error: "not a verified draft" },
    { name: "retry-draft", step: upload, responses: [releaseResponse(true)], calls: ["http:200", "upload"] },
    { name: "upload-fails", step: upload, responses: [releaseResponse(true)], uploadExit: 1, calls: ["http:200", "upload"], error: "Could not upload assets" },
    { name: "published-after-create", step: upload, responses: [{ status: 404 }, listResponse(), releaseResponse(false)], calls: ["http:404", "list:200", "create", "http:200"], error: "not a verified draft" },
    { name: "missing-after-create", step: upload, responses: [{ status: 404 }, listResponse(), { status: 404 }, listResponse()], calls: ["http:404", "list:200", "create", "http:404", "list:200"], error: "not a verified draft" },
    { name: "draft-appears-after-retry", step: upload, lookupAttempts: 3, responses: [{ status: 404 }, listResponse(), { status: 404 }, listResponse(), { status: 404 }, listResponse(true)], calls: ["http:404", "list:200", "create", "http:404", "list:200", "sleep", "http:404", "list:200", "upload"] },
    { name: "draft-never-appears", step: upload, lookupAttempts: 2, responses: [{ status: 404 }, listResponse(), { status: 404 }, listResponse(), { status: 404 }, listResponse()], calls: ["http:404", "list:200", "create", "http:404", "list:200", "sleep", "http:404", "list:200"], error: "not a verified draft" },
    { name: "lookup-fails-after-create", step: upload, responses: [{ status: 404 }, listResponse(), { status: 500 }], calls: ["http:404", "list:200", "create", "http:500"], error: "HTTP 500" },
    { name: "upload-wrong-tag", step: upload, responses: [releaseResponse(true, { tag_name: "v9.9.9" })], calls: ["http:200"], error: "invalid or mismatched" }
  ];
  for (const fixture of cases) {
    const fixturePath = path.join(workflowTemp, `${fixture.name}.json`);
    const tracePath = path.join(workflowTemp, `${fixture.name}.jsonl`);
    const scriptPath = path.join(workflowTemp, `${fixture.name}.ps1`);
    await fs.writeFile(fixturePath, JSON.stringify(fixture));
    await fs.writeFile(scriptPath, `
$ErrorActionPreference = 'Stop'
$fixture = Get-Content -LiteralPath $env:RELEASE_WORKFLOW_FIXTURE -Raw | ConvertFrom-Json
$script:responseIndex = 0
function Write-FixtureTrace($value) {
  ConvertTo-Json -InputObject $value -Compress | Add-Content -LiteralPath $env:RELEASE_WORKFLOW_TRACE
}
function Invoke-WebRequest {
  param($Uri, $Headers, [switch]$SkipHttpErrorCheck, $TimeoutSec, $ErrorAction)
  $isList = $Uri -eq 'https://api.fixture.invalid/repos/fixture/repo/releases?per_page=100'
  if (-not $SkipHttpErrorCheck -or ($Uri -ne 'https://api.fixture.invalid/repos/fixture/repo/releases/tags/v1.2.3' -and -not $isList)) { throw 'Unexpected fixture HTTP request.' }
  if ($script:responseIndex -ge $fixture.responses.Count) { throw 'Unexpected extra HTTP request.' }
  $response = $fixture.responses[$script:responseIndex++]
  if ([bool]$response.list -ne $isList) { throw "Fixture expected a $(if ($response.list) { 'listing' } else { 'tag' }) request but received $Uri." }
  if ($response.transportError) {
    Write-FixtureTrace @{ call = 'http:transport' }
    throw 'Fixture transport failure'
  }
  Write-FixtureTrace @{ call = "$(if ($isList) { 'list' } else { 'http' }):$($response.status)" }
  return [pscustomobject]@{ StatusCode = $response.status; Content = $response.content }
}
function Start-Sleep { param($Seconds) Write-FixtureTrace @{ call = 'sleep' } }
function gh {
  if ($args[0] -ne 'release' -or $args[1] -notin @('create', 'upload')) { throw 'Unexpected fixture gh command.' }
  Write-FixtureTrace @{ call = $args[1]; arguments = @($args) }
  $global:LASTEXITCODE = if ($args[1] -eq 'create') { [int]$fixture.createExit } else { [int]$fixture.uploadExit }
}
${fixture.step.run}
exit 0
`);
    const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath], {
      cwd: workflowTemp, windowsHide: true, encoding: "utf8", timeout: 15000,
      env: { ...process.env, GH_TOKEN: "fixture-token", GH_REPO: "fixture/repo", GITHUB_REPOSITORY: "fixture/repo", GITHUB_API_URL: "https://api.fixture.invalid", GITHUB_REF_NAME: tag, RELEASE_WORKFLOW_FIXTURE: fixturePath, RELEASE_WORKFLOW_TRACE: tracePath, RELEASE_LOOKUP_ATTEMPTS: String(fixture.lookupAttempts || 1) }
    });
    assert.ifError(result.error);
    const output = result.stderr + result.stdout;
    if (fixture.error) {
      assert.notEqual(result.status, 0, `${fixture.name}: the workflow must stop on this failure`);
      assert(output.includes(fixture.error), `${fixture.name}: ${output}`);
    } else {
      assert.equal(result.status, 0, `${fixture.name}: ${output}`);
    }
    const trace = (await fs.readFile(tracePath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(trace.map((entry) => entry.call), fixture.calls, fixture.name);
    for (const entry of trace.filter((entry) => entry.arguments)) {
      assert(!entry.arguments.includes("--clobber"), fixture.name);
      if (entry.call === "create") assert(entry.arguments.includes("--draft") && entry.arguments.includes("--verify-tag"), fixture.name);
    }
    workflowCases++;
  }
} finally {
  const resolved = path.resolve(workflowTemp);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("eb-release-workflow-"));
  await fs.rm(resolved, { recursive: true, force: true });
}
console.log(`MCP release smoke passed: immutable published assets, exact tag/version checks, bundle/manifest/sidecar digests, legacy checksums, Registry metadata, read-only Registry workflow, OIDC-isolated optional signed build, and ${workflowCases} isolated release workflow cases.`);
