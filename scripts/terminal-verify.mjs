import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const artifacts = path.join(root, "artifacts");
const reportPath = path.join(artifacts, "terminal-verification-latest.json");
const markdownPath = path.join(artifacts, "terminal-verification-latest.md");
const electron = path.join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");

function stopTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else process.kill(pid, "SIGKILL");
}

function run(label, command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    console.log(`\n[terminal] ${label}`);
    const startedAt = Date.now();
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    const timeout = setTimeout(() => {
      stopTree(child.pid);
      reject(new Error(`${label} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ label, durationMs: Date.now() - startedAt, stdout, stderr });
      else reject(new Error(`${label} exited with code ${code}.\n${stdout}\n${stderr}`));
    });
  });
}

const runs = [];
runs.push(await run("renderer build", process.execPath, ["scripts/build-terminal.mjs"], 30000));
runs.push(await run("real ConPTY", electron, [".", "--smoke", "--smoke-window", "--smoke-terminal"], 60000));
runs.push(await run("hostile IPC", electron, [".", "--smoke", "--smoke-window", "--smoke-terminal-security"], 60000));
runs.push(await run("per-tab UI", process.execPath, ["scripts/terminal-ui-smoke.mjs"], 120000));

const conptyOutput = `${runs[1].stdout}\n${runs[1].stderr}`;
const securityOutput = `${runs[2].stdout}\n${runs[2].stderr}`;
const firstPromptMs = Number(conptyOutput.match(/firstPromptMs=(\d+)/)?.[1] || NaN);
if (!Number.isFinite(firstPromptMs)) throw new Error("Real ConPTY smoke did not report first-prompt latency.");
if (firstPromptMs > 3000) throw new Error(`Real ConPTY first prompt took ${firstPromptMs} ms, above the 3000 ms product guard.`);
if (!/output=true folderFollow=true dual=true cleaned=true/.test(conptyOutput)) {
  throw new Error("Real ConPTY smoke did not prove output, folder follow, dual sessions, and cleanup.");
}
if (!/terminal security smoke: passed=true/.test(securityOutput)) {
  throw new Error("Hostile terminal IPC smoke did not report a complete pass.");
}
const ui = JSON.parse(await fs.readFile(path.join(artifacts, "terminal-ui-latest.json"), "utf8"));
if (ui.summary?.fail || Number(ui.summary?.pass || 0) < 22) {
  throw new Error(`Terminal UI regression expected at least 22 passes and no failures, received ${JSON.stringify(ui.summary)}.`);
}
const report = {
  generatedAt: new Date().toISOString(),
  firstPromptMs,
  firstPromptGuardMs: 3000,
  realConpty: { output: true, folderFollow: true, dualSessions: true, cleanup: true },
  hostileIpc: { passed: true },
  ui: ui.summary,
  runs: runs.map(({ label, durationMs }) => ({ label, durationMs }))
};
await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await fs.writeFile(
  markdownPath,
  [
    "# Terminal Verification",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Result: real ConPTY, hostile IPC, and ${ui.summary.pass}/${ui.summary.pass} UI checks passed.`,
    `First prompt: ${firstPromptMs} ms (guard: ${report.firstPromptGuardMs} ms).`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    "| Real ConPTY output | Passed |",
    "| Folder follow | Passed |",
    "| Dual sessions | Passed |",
    "| Session cleanup | Passed |",
    "| Hostile IPC boundaries | Passed |",
    `| Product UI regression | ${ui.summary.pass} pass, ${ui.summary.fail} fail |`,
    ""
  ].join("\n"),
  "utf8"
);
console.log("\nTerminal verification passed.");
console.log(`wrote ${markdownPath}`);
