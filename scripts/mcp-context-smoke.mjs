import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assert, startElectronMcp, waitFor } from "./mcp-smoke-helpers.mjs";

const build = spawnSync(process.execPath, [path.join(process.cwd(), "scripts", "build-app.mjs")], {
  cwd: process.cwd(),
  encoding: "utf8",
  windowsHide: true
});
assert(build.status === 0, `Renderer build failed before MCP context verification: ${build.stderr || build.stdout}`);

const harness = await startElectronMcp({ visible: true });
try {
  const tools = await harness.call("tools/list", {});
  const exposedNames = tools.result?.tools?.map((tool) => tool.name).sort() || [];
  const permittedNames = [...harness.profile.tools].sort();
  assert(JSON.stringify(exposedNames) === JSON.stringify(permittedNames), "Desktop MCP sidecar tool discovery did not match the active profile.");
  assert(!exposedNames.includes("apply_operation") && !exposedNames.includes("plan_create"), "Read-only MCP discovery exposed write tools.");
  const live = await waitFor(async () => {
    const response = await harness.call("tools/call", { name: "get_context", arguments: {} });
    return response.result?.structuredContent?.data?.live ? response : null;
  }, 30_000, 250);
  assert(live.result.structuredContent.data.panes.left.tabs[0].id, "Live context is missing stable tab IDs.");
  const child = path.join(harness.fixture, "child");
  await fs.mkdir(child);
  const shown = await harness.call("tools/call", { name: "show_in_explore_better", arguments: { path: child, pane: "left", mode: "newTab" } });
  assert(!shown.result?.isError, `Desktop UI action failed: ${JSON.stringify(shown.result)}`);
  const navigated = await waitFor(async () => {
    const response = await harness.call("tools/call", { name: "get_context", arguments: {} });
    return response.result?.structuredContent?.data?.panes?.left?.path === child ? response : null;
  }, 15_000, 200);
  assert(navigated.result.structuredContent.data.panes.left.tabs.length >= 2, "New-tab AI navigation did not preserve the original tab.");
  const official = spawnSync("go", ["run", "./cmd/conformance", "--sidecar", path.join(process.cwd(), "native", "bin", "ExploreBetterMcp.exe"), "--profile", harness.profile.id, "--manifest", harness.manifest, "--expected-tools", String(harness.profile.tools.length)], {
    cwd: path.join(process.cwd(), "native", "mcpserver"),
    env: harness.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000
  });
  assert(official.status === 0, `Official Go SDK client conformance failed: ${official.stderr || official.stdout}`);
  assert(JSON.parse(official.stdout.trim()).tools === harness.profile.tools.length, "Official Go SDK client returned a tool list that differs from the active profile.");
  console.log("MCP context smoke passed: live tab IDs, validated navigation, and official Go SDK client conformance.");
} finally {
  await harness.close();
}
