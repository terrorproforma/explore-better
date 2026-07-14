import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { assert, startElectronMcp, waitFor } from "./mcp-smoke-helpers.mjs";

const root = process.cwd();
const publish = process.argv.includes("--publish");
const repetitions = 3;
const reportPath = path.join(root, "artifacts", "mcp-value-latest.json");
const markdownPath = path.join(root, "artifacts", "mcp-value-latest.md");
const publicJsonPath = path.join(root, "site", "benchmarks", "mcp-value.json");
const publicMarkdownPath = path.join(root, "site", "benchmarks", "mcp-value.md");

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundMs(value) {
  return Math.round(value * 10) / 10;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

async function makeFixture(base) {
  const catalog = path.join(base, "catalog");
  const reports = path.join(base, "reports");
  const duplicates = path.join(base, "duplicates");
  const contextFolder = path.join(base, "context-target");
  await Promise.all([catalog, reports, duplicates, contextFolder].map((folder) => fs.mkdir(folder, { recursive: true })));

  const writes = [];
  for (let index = 0; index < 360; index += 1) {
    const bytes = Buffer.alloc(320 + index, index % 251);
    bytes.write(`unique-${String(index).padStart(4, "0")}`);
    writes.push(fs.writeFile(path.join(catalog, `asset-${String(index).padStart(4, "0")}.bin`), bytes));
  }
  for (let index = 0; index < 8; index += 1) {
    writes.push(fs.writeFile(
      path.join(reports, `quarterly-review-${String(index + 1).padStart(2, "0")}.txt`),
      `quarterly review ${index + 1}\n${"x".repeat(80 + index)}\n`
    ));
  }
  const duplicateSizes = [4096, 8192, 12288];
  for (let group = 0; group < duplicateSizes.length; group += 1) {
    const bytes = Buffer.alloc(duplicateSizes[group], 40 + group);
    bytes.write(`duplicate-group-${group + 1}`);
    for (let copy = 0; copy < 3; copy += 1) {
      writes.push(fs.writeFile(path.join(duplicates, `group-${group + 1}-copy-${copy + 1}.dat`), bytes));
    }
  }
  writes.push(fs.writeFile(path.join(base, "README.txt"), "Explore Better MCP benchmark fixture\n"));
  writes.push(fs.writeFile(path.join(base, "largest-payload.bin"), Buffer.alloc(128 * 1024, 211)));
  await Promise.all(writes);

  const files = [];
  const stack = [base];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        files.push({ path: fullPath, size: stat.size });
      }
    }
  }
  return {
    catalog,
    reports,
    duplicates,
    contextFolder,
    files: files.length,
    logicalBytes: files.reduce((sum, item) => sum + item.size, 0),
    queryMatches: 8,
    duplicateGroups: duplicateSizes.length,
    duplicateFiles: duplicateSizes.length * 3,
    reclaimableBytes: duplicateSizes.reduce((sum, size) => sum + size * 2, 0)
  };
}

function runPowerShell(script, fixtureRoot) {
  const started = performance.now();
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      cwd: root,
      env: { ...process.env, EB_MCP_VALUE_ROOT: fixtureRoot },
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024
    }
  );
  assert(result.status === 0, `PowerShell baseline failed: ${result.stderr || result.error?.message}`);
  const output = result.stdout.trim();
  return {
    durationMs: roundMs(performance.now() - started),
    outputBytes: Buffer.byteLength(output, "utf8"),
    data: output ? JSON.parse(output) : null
  };
}

function workflowMarkdown(workflow) {
  return `| ${workflow.label} | ${workflow.mcp.correct ? "pass" : "fail"} | ${workflow.powershell.correct ? "pass" : "fail"} | ${workflow.mcp.medianMs} ms | ${workflow.powershell.medianMs} ms |`;
}

function reportMarkdown(report) {
  const lines = [
    "# Explore Better MCP Value Benchmark",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "This benchmark compares the real Explore Better Electron host and Go MCP stdio sidecar with equivalent PowerShell scripts on the same deterministic Windows fixture. It validates correctness first. Timings are reported for transparency, not as a claim that MCP is always faster than a warm shell.",
    "",
    `Result: **${report.summary.workflowsPassed}/${report.summary.workflowsTotal} shared workflows correct in both interfaces**, plus **${report.summary.mcpSpecificProofsPassed}/${report.summary.mcpSpecificProofsTotal} MCP-specific controls proven**.`,
    "",
    "| Workflow | MCP | PowerShell | MCP median | PowerShell median |",
    "| --- | --- | --- | ---: | ---: |",
    ...report.workflows.map(workflowMarkdown),
    "",
    "## What MCP Proved",
    "",
    ...report.proofs.map((proof) => `- **${proof.passed ? "PASS" : "FAIL"} - ${proof.label}:** ${proof.detail}`),
    "",
    "## Interpretation",
    "",
    "PowerShell remains better for arbitrary commands and one-off system administration. Explore Better MCP is valuable when an AI needs the file manager's live pane context, bounded typed results, indexed/analyzer semantics, folder-scoped authorization, or plan/apply operations that use the app's transaction journal. It complements the terminal rather than replacing it.",
    "",
    "## Reproduce",
    "",
    "```powershell",
    "npm run verify:mcp-value",
    "```",
    "",
    "The machine-readable report is published at [mcp-value.json](./mcp-value.json)."
  ];
  return `${lines.join("\n")}\n`;
}

async function updatePublicBenchmarkTable(report) {
  const pagePath = path.join(root, "site", "mcp", "index.html");
  let html = await fs.readFile(pagePath, "utf8");
  for (const workflow of report.workflows) {
    const values = {
      [`${workflow.id}:mcp`]: `${workflow.mcp.medianMs} ms`,
      [`${workflow.id}:powershell`]: `${workflow.powershell.medianMs} ms`
    };
    for (const [key, value] of Object.entries(values)) {
      const pattern = new RegExp(`(<td data-benchmark="${key}">)[^<]*(</td>)`);
      assert(pattern.test(html), `Public MCP page is missing benchmark cell ${key}.`);
      html = html.replace(pattern, `$1${value}$2`);
    }
  }
  await fs.writeFile(pagePath, html, "utf8");
}

async function main() {
  assert(process.platform === "win32", "The MCP value benchmark currently targets Windows.");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const harness = await startElectronMcp({ visible: true, prepareFixture: makeFixture });
  const rawCalls = [];
  try {
    const fixture = harness.preparedFixture;
    const outsideFile = path.join(harness.temp, "outside-proof.txt");
    await fs.writeFile(outsideFile, "outside authorized roots\n");

    async function callTool(name, args = {}) {
      const started = performance.now();
      const response = await harness.call("tools/call", { name, arguments: args });
      const durationMs = roundMs(performance.now() - started);
      assert(!response.error, `MCP ${name} JSON-RPC failure: ${JSON.stringify(response.error)}`);
      const result = response.result || {};
      const structured = result.structuredContent || null;
      rawCalls.push({ name, durationMs, outputBytes: byteLength(result) });
      return { response, result, structured, durationMs, outputBytes: byteLength(result) };
    }

    async function runJob(name, args) {
      const started = performance.now();
      const initial = await callTool(name, args);
      assert(!initial.result.isError, `MCP ${name} failed: ${JSON.stringify(initial.structured?.error)}`);
      const jobId = initial.structured?.data?.job?.id;
      assert(jobId, `MCP ${name} did not return a job ID.`);
      let outputBytes = initial.outputBytes;
      let polls = 0;
      const complete = await waitFor(async () => {
        polls += 1;
        const status = await callTool("get_job", { jobId, limit: 500 });
        outputBytes += status.outputBytes;
        const data = status.structured?.data;
        if (["error", "canceled"].includes(data?.status)) {
          throw new Error(`MCP ${name} job ended as ${data.status}.`);
        }
        return data?.status === "complete" ? data : null;
      }, 120_000, 40);
      return {
        data: complete.result,
        durationMs: roundMs(performance.now() - started),
        outputBytes,
        polls,
        schemaVersion: initial.structured?.schemaVersion
      };
    }

    const toolList = await harness.call("tools/list", {});
    const tools = toolList.result?.tools || [];
    assert(tools.length === harness.profile.tools.length, "Read-only profile discovery differs from the MCP tool list.");

    const listing = await callTool("list_directory", { path: fixture.catalog, limit: 25 });
    assert(!listing.result.isError, `MCP bounded listing failed: ${JSON.stringify(listing.structured?.error)}`);
    const listingEntries = listing.structured?.data?.entries || [];
    const listingCursor = listing.structured?.nextCursor;
    assert(listingEntries.length > 0 && listingEntries.length <= 25, `MCP bounded listing returned ${listingEntries.length} entries for a 25-entry limit.`);
    assert(typeof listingCursor === "string", "MCP bounded listing did not return an opaque next cursor.");
    const nextListing = await callTool("list_directory", { path: fixture.catalog, limit: 25, cursor: listingCursor });
    assert(!nextListing.result.isError, `MCP continuation listing failed: ${JSON.stringify(nextListing.structured?.error)}`);
    const nextListingEntries = nextListing.structured?.data?.entries || [];
    assert(nextListingEntries.length > 0 && nextListingEntries.length <= 25, `MCP continuation listing returned ${nextListingEntries.length} entries for a 25-entry limit.`);
    const firstPagePaths = new Set(listingEntries.map((entry) => entry.path));
    assert(nextListingEntries.every((entry) => !firstPagePaths.has(entry.path)), "MCP continuation page repeated entries from the first page.");
    const boundedPaginationPassed = listingEntries.length <= 25 && nextListingEntries.length <= 25;

    const mcpSearchRuns = [];
    const shellSearchRuns = [];
    const searchScript = String.raw`
$ErrorActionPreference = "Stop"
$root = $env:EB_MCP_VALUE_ROOT
$items = @(Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.Name -like "*quarterly*" } | Sort-Object FullName | ForEach-Object { [pscustomobject]@{ name = $_.Name; size = $_.Length } })
ConvertTo-Json -Compress -InputObject $items
`;
    for (let run = 0; run < repetitions; run += 1) {
      const mcp = await callTool("search_files", { path: harness.fixture, query: "quarterly", kind: "files", limit: 100, maxScanned: 5000 });
      mcpSearchRuns.push({ durationMs: mcp.durationMs, outputBytes: mcp.outputBytes, count: mcp.structured?.data?.entries?.length || 0 });
      shellSearchRuns.push(runPowerShell(searchScript, harness.fixture));
    }

    const mcpDuplicateRuns = [];
    const shellDuplicateRuns = [];
    const duplicateScript = String.raw`
$ErrorActionPreference = "Stop"
$root = $env:EB_MCP_VALUE_ROOT
$files = @(Get-ChildItem -LiteralPath $root -Recurse -File)
$groups = foreach ($sizeGroup in @($files | Group-Object Length | Where-Object Count -gt 1)) {
  $hashed = @($sizeGroup.Group | ForEach-Object { $hash = Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256; [pscustomobject]@{ hash = $hash.Hash; size = $_.Length } })
  foreach ($hashGroup in @($hashed | Group-Object hash | Where-Object Count -gt 1)) {
    [pscustomobject]@{ hash = $hashGroup.Name; size = [int64]$hashGroup.Group[0].size; count = $hashGroup.Count; wastedBytes = [int64]$hashGroup.Group[0].size * ($hashGroup.Count - 1) }
  }
}
ConvertTo-Json -Compress -InputObject @($groups)
`;
    for (let run = 0; run < repetitions; run += 1) {
      const mcp = await runJob("find_duplicates", { path: harness.fixture, mode: "hash", recursive: true, maxEntries: 2000 });
      mcpDuplicateRuns.push({
        durationMs: mcp.durationMs,
        outputBytes: mcp.outputBytes,
        groupCount: mcp.data?.groupCount || 0,
        duplicateFiles: mcp.data?.duplicateFiles || 0,
        wastedBytes: mcp.data?.wastedBytes || 0
      });
      shellDuplicateRuns.push(runPowerShell(duplicateScript, harness.fixture));
    }

    const mcpAnalysisRuns = [];
    const shellAnalysisRuns = [];
    const analysisScript = String.raw`
$ErrorActionPreference = "Stop"
$root = $env:EB_MCP_VALUE_ROOT
$files = @(Get-ChildItem -LiteralPath $root -Recurse -File)
$sum = ($files | Measure-Object -Property Length -Sum).Sum
$top = @($files | Sort-Object Length -Descending | Select-Object -First 10 | ForEach-Object { [pscustomobject]@{ name = $_.Name; size = $_.Length } })
[pscustomobject]@{ files = $files.Count; bytes = [int64]$sum; top = $top; allocatedBytes = $null; allocationAccuracy = "not-reported" } | ConvertTo-Json -Compress -Depth 4
`;
    for (let run = 0; run < repetitions; run += 1) {
      const mcp = await runJob("analyze_disk_usage", { path: harness.fixture, maxEntries: 2000, maxDepth: 5, maxChildren: 36 });
      mcpAnalysisRuns.push({
        durationMs: mcp.durationMs,
        outputBytes: mcp.outputBytes,
        files: mcp.data?.summary?.files || 0,
        bytes: mcp.data?.summary?.bytes || 0,
        allocatedBytes: mcp.data?.summary?.allocated ?? null,
        allocationAccuracy: mcp.data?.allocationAccuracy || "unknown"
      });
      shellAnalysisRuns.push(runPowerShell(analysisScript, harness.fixture));
    }

    const liveContext = await waitFor(async () => {
      const context = await callTool("get_context");
      return context.structured?.data?.live ? context : null;
    }, 30_000, 200);
    const show = await callTool("show_in_explore_better", { path: fixture.contextFolder, pane: "left", mode: "newTab" });
    assert(!show.result.isError, `MCP UI navigation failed: ${JSON.stringify(show.structured?.error)}`);
    const navigatedContext = await waitFor(async () => {
      const context = await callTool("get_context");
      return context.structured?.data?.panes?.left?.path === fixture.contextFolder ? context : null;
    }, 15_000, 150);

    const outside = await callTool("read_text", { path: outsideFile });
    const outsideCode = outside.structured?.error?.code || "";
    const readOnlyToolNames = new Set(tools.map((tool) => tool.name));
    const hiddenWriteTools = ["plan_delete", "plan_transfer", "plan_text_write", "apply_operation"]
      .every((name) => !readOnlyToolNames.has(name));

    const searchMcpCorrect = mcpSearchRuns.every((item) => item.count === fixture.queryMatches);
    const searchShellCorrect = shellSearchRuns.every((item) => asArray(item.data).length === fixture.queryMatches);
    const duplicatesMcpCorrect = mcpDuplicateRuns.every((item) =>
      item.groupCount === fixture.duplicateGroups && item.duplicateFiles === fixture.duplicateFiles && item.wastedBytes === fixture.reclaimableBytes
    );
    const duplicatesShellCorrect = shellDuplicateRuns.every((item) => {
      const groups = asArray(item.data);
      return groups.length === fixture.duplicateGroups &&
        groups.reduce((sum, group) => sum + Number(group.count || 0), 0) === fixture.duplicateFiles &&
        groups.reduce((sum, group) => sum + Number(group.wastedBytes || 0), 0) === fixture.reclaimableBytes;
    });
    const analysisMcpCorrect = mcpAnalysisRuns.every((item) => item.files === fixture.files && item.bytes === fixture.logicalBytes);
    const analysisShellCorrect = shellAnalysisRuns.every((item) => item.data?.files === fixture.files && item.data?.bytes === fixture.logicalBytes);

    const workflows = [
      {
        id: "filename-search",
        label: "Find matching reports",
        groundTruth: { matches: fixture.queryMatches },
        mcp: {
          correct: searchMcpCorrect,
          medianMs: roundMs(median(mcpSearchRuns.map((item) => item.durationMs))),
          medianOutputBytes: Math.round(median(mcpSearchRuns.map((item) => item.outputBytes))),
          runsMs: mcpSearchRuns.map((item) => item.durationMs),
          interface: "typed search_files response"
        },
        powershell: {
          correct: searchShellCorrect,
          medianMs: roundMs(median(shellSearchRuns.map((item) => item.durationMs))),
          medianOutputBytes: Math.round(median(shellSearchRuns.map((item) => item.outputBytes))),
          runsMs: shellSearchRuns.map((item) => item.durationMs),
          interface: "custom Get-ChildItem pipeline serialized to JSON"
        }
      },
      {
        id: "duplicate-space",
        label: "Find content duplicates",
        groundTruth: { groups: fixture.duplicateGroups, duplicateFiles: fixture.duplicateFiles, reclaimableBytes: fixture.reclaimableBytes },
        mcp: {
          correct: duplicatesMcpCorrect,
          medianMs: roundMs(median(mcpDuplicateRuns.map((item) => item.durationMs))),
          medianOutputBytes: Math.round(median(mcpDuplicateRuns.map((item) => item.outputBytes))),
          runsMs: mcpDuplicateRuns.map((item) => item.durationMs),
          interface: "cancellable find_duplicates job"
        },
        powershell: {
          correct: duplicatesShellCorrect,
          medianMs: roundMs(median(shellDuplicateRuns.map((item) => item.durationMs))),
          medianOutputBytes: Math.round(median(shellDuplicateRuns.map((item) => item.outputBytes))),
          runsMs: shellDuplicateRuns.map((item) => item.durationMs),
          interface: "custom size-group and Get-FileHash pipeline"
        }
      },
      {
        id: "disk-usage",
        label: "Measure disk usage",
        groundTruth: { files: fixture.files, logicalBytes: fixture.logicalBytes },
        mcp: {
          correct: analysisMcpCorrect,
          medianMs: roundMs(median(mcpAnalysisRuns.map((item) => item.durationMs))),
          medianOutputBytes: Math.round(median(mcpAnalysisRuns.map((item) => item.outputBytes))),
          runsMs: mcpAnalysisRuns.map((item) => item.durationMs),
          allocationAccuracy: mcpAnalysisRuns[0].allocationAccuracy,
          allocatedBytesReported: Number.isFinite(mcpAnalysisRuns[0].allocatedBytes),
          interface: "cancellable analyzer job with treemap and allocation metadata"
        },
        powershell: {
          correct: analysisShellCorrect,
          medianMs: roundMs(median(shellAnalysisRuns.map((item) => item.durationMs))),
          medianOutputBytes: Math.round(median(shellAnalysisRuns.map((item) => item.outputBytes))),
          runsMs: shellAnalysisRuns.map((item) => item.durationMs),
          allocationAccuracy: "not-reported",
          allocatedBytesReported: false,
          interface: "custom Get-ChildItem and Measure-Object pipeline"
        }
      }
    ];

    const proofs = [
      {
        id: "schema-discovery",
        label: "Model-discoverable typed contract",
        passed: tools.length === harness.profile.tools.length && tools.every((tool) => tool.inputSchema?.type === "object"),
        detail: `${tools.length} profile-permitted tools exposed with JSON input schemas; destructive tools are absent from discovery.`
      },
      {
        id: "bounded-pagination",
        label: "Bounded pagination",
        passed: boundedPaginationPassed,
        detail: `A 360-entry folder returned ${listingEntries.length} then ${nextListingEntries.length} entries for a 25-entry limit, with an opaque cursor and no overlap.`
      },
      {
        id: "live-ui-context",
        label: "Live file-manager context",
        passed: liveContext.structured?.data?.live === true && navigatedContext.structured?.data?.panes?.left?.path === fixture.contextFolder,
        detail: "The AI read live tab context, opened a folder in a new left-pane tab, then observed the revised pane state."
      },
      {
        id: "root-boundary",
        label: "Authorized-root enforcement",
        passed: outside.result.isError === true && outsideCode === "OUTSIDE_ROOTS",
        detail: `A read outside the profile root was rejected with ${outsideCode || "no code"}. A normal shell retains the user's broader filesystem authority.`
      },
      {
        id: "read-only-discovery",
        label: "Read-only capability reduction",
        passed: hiddenWriteTools,
        detail: "plan_delete, plan_transfer, plan_text_write, and apply_operation were not exposed to the read-only profile."
      },
      {
        id: "allocation-semantics",
        label: "File-manager-specific allocation semantics",
        passed: mcpAnalysisRuns.every((item) => ["exact", "estimated", "unknown"].includes(item.allocationAccuracy)) && mcpAnalysisRuns.some((item) => Number.isFinite(item.allocatedBytes)),
        detail: `Analyzer returned labeled ${mcpAnalysisRuns[0].allocationAccuracy} allocation data; the generic PowerShell baseline reported logical bytes only.`
      }
    ];

    assert(workflows.every((workflow) => workflow.mcp.correct && workflow.powershell.correct), "A shared benchmark workflow returned an incorrect result.");
    assert(proofs.every((proof) => proof.passed), "An MCP-specific value proof failed.");

    const report = {
      schema: "explore-better.mcp-value.v1",
      generatedAt: new Date().toISOString(),
      appVersion: packageJson.version,
      protocolVersion: harness.initialized.result?.protocolVersion || "2025-11-25",
      methodology: {
        repetitions,
        correctnessFirst: true,
        timingScope: "MCP timings include the tool call and job polling. PowerShell timings include process startup and command execution.",
        limitation: "This is a deterministic functional comparison, not a universal performance ranking. A persistent warm shell may have lower startup latency."
      },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        cpu: os.cpus()[0]?.model || "unknown"
      },
      fixture: {
        files: fixture.files,
        logicalBytes: fixture.logicalBytes,
        catalogEntries: 360,
        queryMatches: fixture.queryMatches,
        duplicateGroups: fixture.duplicateGroups,
        duplicateFiles: fixture.duplicateFiles,
        reclaimableBytes: fixture.reclaimableBytes
      },
      summary: {
        workflowsPassed: workflows.filter((workflow) => workflow.mcp.correct && workflow.powershell.correct).length,
        workflowsTotal: workflows.length,
        mcpSpecificProofsPassed: proofs.filter((proof) => proof.passed).length,
        mcpSpecificProofsTotal: proofs.length,
        conclusion: "MCP does not replace a shell. It adds typed discovery, live Explore Better context, bounded outputs, least-authority profiles, and application-level file semantics that generic terminal access does not provide by default."
      },
      workflows,
      proofs,
      transport: {
        implementation: "ExploreBetterMcp.exe Go stdio sidecar over authenticated same-user Electron named pipe",
        discoveredTools: tools.length,
        rawToolCalls: rawCalls.length
      }
    };

    const markdown = reportMarkdown(report);
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(markdownPath, markdown, "utf8");
    if (publish) {
      await fs.mkdir(path.dirname(publicJsonPath), { recursive: true });
      await fs.writeFile(publicJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      await fs.writeFile(publicMarkdownPath, markdown, "utf8");
      await updatePublicBenchmarkTable(report);
    }
    console.log(`MCP value benchmark: ${report.summary.workflowsPassed}/${report.summary.workflowsTotal} shared workflows and ${report.summary.mcpSpecificProofsPassed}/${report.summary.mcpSpecificProofsTotal} MCP-specific proofs passed.`);
    console.log(`Evidence: ${reportPath}`);
    if (publish) console.log(`Public evidence: ${publicJsonPath}`);
  } finally {
    await harness.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
