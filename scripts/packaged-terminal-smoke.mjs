import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const artifactsDir = path.join(root, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `packaged-terminal-${stamp}`);
const appData = path.join(runRoot, "appdata");
const fixture = path.join(runRoot, "Folder With Spaces Unicode");
const executable = path.join(root, "dist", "win-unpacked", "Explore Better.exe");
const ptyPrebuild = path.join(root, "dist", "win-unpacked", "resources", "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "win32-x64", "pty.node");
const terminalBundle = path.join(root, "dist", "win-unpacked", "resources", "app.asar");
const latestJson = path.join(artifactsDir, "packaged-terminal-latest.json");
const latestMd = path.join(artifactsDir, "packaged-terminal-latest.md");

function stopTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else process.kill(pid, "SIGKILL");
}

function runPackagedApp(envOverrides = {}, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(executable, ["--smoke", "--smoke-window", "--smoke-terminal", "--no-updates"], {
      cwd: root,
      env: {
        ...process.env,
        EXPLORE_BETTER_USER_DATA_DIR: path.join(appData, "ElectronUserData"),
        EXPLORE_BETTER_WORKSPACE_ROOT: fixture,
        EXPLORE_BETTER_WORKSPACE_LABEL: "Terminal Smoke",
        EXPLORE_BETTER_DISABLE_GPU: "1",
        LOCALAPPDATA: appData,
        APPDATA: appData,
        ...envOverrides
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ...result, stdout, stderr });
    };
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => finish({ code: null, error: error.message }));
    child.once("exit", (code) => finish({ code }));
    const timeout = setTimeout(() => {
      stopTree(child.pid);
      finish({ code: null, timedOut: true });
    }, timeoutMs);
  });
}

function markdown(report) {
  const rows = report.checks.map((item) => `| ${item.pass ? "PASS" : "FAIL"} | ${item.name} | ${String(item.detail).replaceAll("|", "\\|")} |`).join("\n");
  return `# Packaged Terminal Smoke\n\nGenerated: ${report.generatedAt}\n\nStatus: ${report.status}\n\n| Status | Check | Detail |\n| --- | --- | --- |\n${rows}\n\n## Runtime Result\n\n\`${report.terminalLine || "missing"}\`\n`;
}

async function main() {
  await fs.mkdir(fixture, { recursive: true });
  const firstFolder = path.join(fixture, "First Folder");
  const latestFolder = path.join(fixture, "Latest Folder");
  await fs.mkdir(firstFolder, { recursive: true });
  await fs.mkdir(latestFolder, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.writeFile(path.join(fixture, "terminal-smoke.txt"), "packaged terminal\n", "utf8");
  const checks = [];
  const add = (pass, name, detail) => checks.push({ pass: Boolean(pass), name, detail });
  await fs.access(executable);
  await fs.access(ptyPrebuild);
  await fs.access(terminalBundle);
  add(true, "Packaged executable exists", executable);
  add(true, "Native node-pty x64 prebuild is unpacked", ptyPrebuild);
  add(true, "Packaged application archive exists", terminalBundle);

  const smokeFolders = {
    EXPLORE_BETTER_TERMINAL_SMOKE_FIRST_CWD: firstFolder,
    EXPLORE_BETTER_TERMINAL_SMOKE_LATEST_CWD: latestFolder
  };
  const result = await runPackagedApp(smokeFolders);
  const terminalLine = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("Explore Better terminal smoke:")) || "";
  const promptMatch = terminalLine.match(/firstPromptMs=(\d+)/);
  const firstPromptMs = Number(promptMatch?.[1] || 0);
  add(result.code === 0 && !result.timedOut && !result.error, "Packaged app exits cleanly", result.error || (result.timedOut ? "Timed out" : `Exit ${result.code}`));
  add(terminalLine.includes("output=true"), "Packaged PTY accepts input and returns output", terminalLine || "Missing terminal smoke output");
  add(terminalLine.includes("folderFollow=true"), "Busy folder following keeps only the latest destination", terminalLine || "Missing terminal smoke output");
  add(terminalLine.includes("dual=true"), "Packaged app runs simultaneous pane terminals", terminalLine || "Missing terminal smoke output");
  add(terminalLine.includes("cleaned=true"), "Packaged sessions clean up before exit", terminalLine || "Missing terminal smoke output");
  add(firstPromptMs > 0, "First prompt timing is recorded", firstPromptMs ? `${firstPromptMs} ms` : "Missing timing");

  const fastRuns = [];
  for (let index = 0; index < 3; index += 1) {
    const fastResult = await runPackagedApp({ ...smokeFolders, EXPLORE_BETTER_TERMINAL_PROFILE: "command-prompt" });
    const line = fastResult.stdout.split(/\r?\n/).map((item) => item.trim()).find((item) => item.startsWith("Explore Better terminal smoke:")) || "";
    const elapsed = Number(line.match(/firstPromptMs=(\d+)/)?.[1] || 0);
    fastRuns.push({ result: fastResult, terminalLine: line, firstPromptMs: elapsed });
  }
  const fastTimings = fastRuns.map((item) => item.firstPromptMs).filter((value) => value > 0).sort((left, right) => left - right);
  const fastMedianMs = fastTimings.length === 3 ? fastTimings[1] : 0;
  const fastRunsPassed = fastRuns.every((item) => item.result.code === 0 && !item.result.timedOut && item.terminalLine.includes("output=true") && item.terminalLine.includes("folderFollow=true") && item.terminalLine.includes("dual=true") && item.terminalLine.includes("cleaned=true"));
  add(fastRunsPassed, "Packaged fast-profile repetitions pass", fastRuns.map((item) => item.terminalLine || item.result.error || "missing").join("; "));
  add(fastMedianMs > 0 && fastMedianMs <= 750, "Standard terminal first-prompt median is within 750 ms", fastMedianMs ? `${fastMedianMs} ms` : "Missing timing");

  const failures = checks.filter((item) => !item.pass);
  const report = { generatedAt: new Date().toISOString(), status: failures.length ? "fail" : "pass", executable, ptyPrebuild, terminalBundle, terminalLine, firstPromptMs, defaultProfilePerformanceGatePassed: firstPromptMs > 0 && firstPromptMs <= 750, fastProfile: "command-prompt", fastRuns, fastMedianMs, performanceGateMs: 750, performanceGatePassed: fastMedianMs > 0 && fastMedianMs <= 750, checks, result };
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(latestJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(latestMd, markdown(report), "utf8");
  await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  console.log(`Packaged terminal: ${checks.length - failures.length} pass, ${failures.length} fail`);
  console.log(terminalLine || "Packaged terminal output was missing.");
  console.log(`Default PowerShell-first timing: ${firstPromptMs || "missing"} ms`);
  console.log(`First prompt performance gate: ${report.performanceGatePassed ? "PASS" : "FAIL"} (${fastMedianMs || "missing"} ms median / ${report.performanceGateMs} ms)`);
  if (failures.length) {
    console.error(failures.map((item) => `${item.name}: ${item.detail}`).join("\n"));
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  process.exitCode = 1;
});
