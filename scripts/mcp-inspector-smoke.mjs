import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assert, root, startElectronMcp } from "./mcp-smoke-helpers.mjs";

const npmVersion = "11.6.2";

async function ensureNpxCli() {
  const toolingDir = path.join(root, "artifacts", "npm-runtime");
  const npxCli = path.join(toolingDir, "node_modules", "npm", "bin", "npx-cli.js");
  try {
    await fs.access(npxCli);
    return npxCli;
  } catch {
    const pnpmCli = process.env.PNPM_CLI_PATH || path.resolve(path.dirname(process.execPath), "..", "node_modules", "pnpm", "bin", "pnpm.cjs");
    await fs.mkdir(toolingDir, { recursive: true });
    await fs.writeFile(
      path.join(toolingDir, "package.json"),
      `${JSON.stringify({ name: "explore-better-npm-runtime", private: true, version: "0.0.0" }, null, 2)}\n`,
      "utf8"
    );
    const provision = spawnSync(
      process.execPath,
      [pnpmCli, "--dir", toolingDir, "add", `npm@${npmVersion}`, "--save-exact"],
      { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000 }
    );
    assert(
      provision.status === 0,
      `Could not provision the self-contained MCP Inspector runtime: ${provision.stderr || provision.stdout || provision.error?.message || provision.status}`
    );
    return npxCli;
  }
}

const harness = await startElectronMcp();
try {
  const sidecar = path.join(root, "native", "bin", "ExploreBetterMcp.exe");
  const command = [
    "-y", "@modelcontextprotocol/inspector@0.21.2", "--cli", sidecar,
    "--profile", harness.profile.id, "--manifest", harness.manifest, "--method", "tools/list"
  ];
  const npxCli = await ensureNpxCli();
  const inspectorEnv = { ...harness.env, MCP_AUTO_OPEN_ENABLED: "false" };
  const pathKey = Object.keys(inspectorEnv).find((key) => key.toLowerCase() === "path") || "PATH";
  inspectorEnv[pathKey] = `${path.dirname(process.execPath)};${inspectorEnv[pathKey] || ""}`;
  const inspector = spawnSync(process.execPath, [npxCli, ...command], {
    cwd: root,
    env: inspectorEnv,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024
  });
  assert(inspector.status === 0, `MCP Inspector CLI failed: ${inspector.error?.message || inspector.stderr || inspector.stdout || `status ${inspector.status}`}`);
  const output = `${inspector.stdout}\n${inspector.stderr}`;
  assert(harness.profile.tools.every((tool) => output.includes(tool)), "MCP Inspector did not receive every profile-permitted Explore Better tool.");
  assert(!output.includes("apply_operation") && !output.includes("plan_create"), "MCP Inspector received write tools from a read-only profile.");
  const report = {
    schema: "explore-better.mcp-inspector.v1",
    generatedAt: new Date().toISOString(),
    inspectorVersion: "0.21.2",
    method: "tools/list",
    status: "pass",
    expectedTools: harness.profile.tools.length,
    output: output.slice(0, 32_000)
  };
  await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
  await fs.writeFile(path.join(root, "artifacts", "mcp-inspector-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`MCP Inspector smoke passed: Inspector 0.21.2 negotiated stdio and listed ${harness.profile.tools.length} profile-permitted tools.`);
} finally {
  await harness.close();
}
