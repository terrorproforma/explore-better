import { performance } from "node:perf_hooks";
import { assert, startElectronMcp } from "./mcp-smoke-helpers.mjs";

const harness = await startElectronMcp();
try {
  const samples = [];
  for (let index = 0; index < 25; index += 1) {
    const started = performance.now();
    const result = await harness.call("tools/call", { name: "get_context", arguments: {} });
    assert(result.result?.structuredContent?.status === "ok", "Warm MCP context call failed.");
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const processInfo = await import("node:child_process").then(({ spawnSync }) => spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${harness.sidecar.pid}).WorkingSet64`], { encoding: "utf8", windowsHide: true }));
  const rssMb = Number(processInfo.stdout.trim()) / 1024 / 1024;
  assert(p95 <= 20, `Warm MCP bridge p95 ${p95.toFixed(1)} ms exceeds 20 ms.`);
  assert(rssMb <= 30, `Sidecar RSS ${rssMb.toFixed(1)} MB exceeds 30 MB.`);
  console.log(`MCP performance smoke passed: warm p95=${p95.toFixed(1)} ms, sidecar RSS=${rssMb.toFixed(1)} MB.`);
} finally {
  await harness.close();
}
