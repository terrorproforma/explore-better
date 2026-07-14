import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assert, root } from "./mcp-smoke-helpers.mjs";

const contractBytes = await fs.readFile(path.join(root, "mcp", "contracts-v1.json"));
const contract = JSON.parse(contractBytes);
assert(contract.bridgeProtocolVersion === 1, "Bridge protocol must be v1.");
assert(contract.mcpProtocolVersion === "2025-11-25", "Unexpected MCP protocol version.");
assert(contract.tools.length === 28, `Expected 28 tools, found ${contract.tools.length}.`);
assert(new Set(contract.tools.map((tool) => tool.name)).size === contract.tools.length, "Tool names must be unique.");
assert(contract.tools.every((tool) => tool.inputSchema?.type === "object" && tool.annotations), "Every tool needs an object schema and annotations.");

const sidecar = path.join(root, "native", "bin", "ExploreBetterMcp.exe");
await fs.access(sidecar);
const selfTest = spawnSync(sidecar, ["--self-test-contract"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
assert(selfTest.status === 0, `Sidecar contract self-test failed: ${selfTest.stderr || selfTest.error?.message}`);
const report = JSON.parse(selfTest.stdout.trim());
assert(report.ok && report.mcpProtocolVersion === contract.mcpProtocolVersion, "Sidecar embedded an incompatible MCP contract.");
assert(report.tools === contract.tools.length && report.resources === contract.resources.length && report.prompts === contract.prompts.length, "Sidecar embedded contract counts differ from the canonical contract.");
const hash = crypto.createHash("sha256").update(contractBytes).digest("hex");
assert(report.sha256 === hash, "Sidecar embedded contract hash differs from the canonical contract.");
console.log(`MCP contract smoke passed: ${contract.tools.length} tools, ${contract.resources.length} resources, ${contract.prompts.length} prompts, sha256=${hash}`);
