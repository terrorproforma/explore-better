import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assert, root } from "./mcp-smoke-helpers.mjs";

const source = path.join(root, "native", "bin", "ExploreBetterMcp.exe");
const packaged = path.join(root, "dist", "win-unpacked", "resources", "native", "ExploreBetterMcp.exe");
await fs.access(source);
await fs.access(packaged);
const hash = async (file) => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
assert(await hash(source) === await hash(packaged), "Packaged MCP sidecar differs from the source build.");
const result = spawnSync(packaged, ["--self-test-contract"], { encoding: "utf8", windowsHide: true });
assert(result.status === 0, `Packaged MCP sidecar self-test failed: ${result.stderr}`);
const report = JSON.parse(result.stdout);
assert(report.ok && report.tools === 28 && report.mcpProtocolVersion === "2025-11-25", "Packaged MCP contract report is invalid.");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
assert(packageJson.build.extraResources.some((item) => item.to === "native/ExploreBetterMcp.exe"), "Package metadata does not include the MCP sidecar.");
console.log(`Packaged MCP smoke passed: ${report.tools} tools, sha256=${await hash(packaged)}.`);
