import { promises as fs } from "node:fs";
import path from "node:path";
import { assert, createBackendFixture, waitForJob } from "./mcp-smoke-helpers.mjs";

const fixture = await createBackendFixture();
try {
  const first = path.join(fixture.fixture, "first.txt");
  const second = path.join(fixture.fixture, "second.txt");
  await fs.writeFile(first, "duplicate-content\n");
  await fs.copyFile(first, second);
  await fs.mkdir(path.join(fixture.fixture, "nested"));
  await fs.writeFile(path.join(fixture.fixture, "nested", "large.bin"), Buffer.alloc(64 * 1024, 7));

  const checksums = await fixture.request("compute_checksums", { paths: [first, second], algorithm: "sha256" });
  const checksumJob = await waitForJob(fixture.request, checksums.data.job.id);
  assert(checksumJob.result.items.length === 2, "Checksum job did not hash both files.");
  assert(checksumJob.result.items[0].hash === checksumJob.result.items[1].hash, "Duplicate checksums differ.");
  const durableJob = JSON.parse(await fs.readFile(path.join(process.env.LOCALAPPDATA, "ExploreBetter", "MCP", "jobs", `${checksums.data.job.id}.json`), "utf8"));
  assert(durableJob.status === "complete" && durableJob.result.items.length === 2, "Completed job state was not durably persisted.");

  const duplicates = await fixture.request("find_duplicates", { path: fixture.fixture, mode: "hash", maxEntries: 1000 });
  const duplicateJob = await waitForJob(fixture.request, duplicates.data.job.id);
  assert(duplicateJob.result.groupCount >= 1, "Duplicate analysis did not find the fixture pair.");

  const analysis = await fixture.request("analyze_disk_usage", { path: fixture.fixture, maxEntries: 1000, maxDepth: 4 });
  const analysisJob = await waitForJob(fixture.request, analysis.data.job.id);
  assert(analysisJob.result.summary.files >= 3, "Disk analysis did not scan the fixture.");
  assert(["exact", "estimated", "unknown"].includes(analysisJob.result.allocationAccuracy), "Allocation accuracy is not labeled.");

  const cancelCandidate = await fixture.request("analyze_disk_usage", { path: fixture.fixture, maxEntries: 1000, maxDepth: 4 });
  const canceled = await fixture.request("cancel_job", { jobId: cancelCandidate.data.job.id });
  assert(canceled.status === "canceled" && canceled.data.status === "canceled", "Live analysis cancellation did not settle promptly.");
  console.log(`MCP analysis smoke passed: ${analysisJob.result.summary.files} files, ${duplicateJob.result.groupCount} duplicate group(s), durable jobs, and cancellation.`);
} finally {
  await fixture.cleanup();
}
process.exit(0);
