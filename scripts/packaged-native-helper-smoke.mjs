import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const artifactsDir = path.join(root, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `packaged-native-helper-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const executable = path.join(root, "dist", "win-unpacked", "Explore Better.exe");
const sourceHelper = path.join(root, "native", "bin", "explore-better-fs.exe");
const packagedHelper = path.join(root, "dist", "win-unpacked", "resources", "native", "explore-better-fs.exe");
const latestJson = path.join(artifactsDir, "packaged-native-helper-latest.json");
const latestMd = path.join(artifactsDir, "packaged-native-helper-latest.md");

async function sha256(file) {
  const content = await fs.readFile(file);
  return createHash("sha256").update(content).digest("hex");
}

function stopTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
}

function runPackagedApp(args, env, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: { ...process.env, ...env },
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
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => finish({ code: null, error: error.message }));
    child.once("exit", (code) => finish({ code }));
    const timeout = setTimeout(() => {
      stopTree(child.pid);
      finish({ code: null, timedOut: true });
    }, timeoutMs);
  });
}

function markdown(report) {
  const rows = report.checks
    .map((item) => `| ${item.pass ? "PASS" : "FAIL"} | ${item.name} | ${String(item.detail).replaceAll("|", "\\|")} |`)
    .join("\n");
  return `# Packaged Native Helper Smoke\n\nGenerated: ${report.generatedAt}\n\nStatus: ${report.status}\n\n| Status | Check | Detail |\n| --- | --- | --- |\n${rows}\n\n## Native Result\n\n\`${report.nativeLine || "missing"}\`\n`;
}

async function main() {
  await fs.mkdir(fixture, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.writeFile(path.join(fixture, "sample.bin"), Buffer.alloc(8193, 7));
  await fs.mkdir(path.join(fixture, "nested"));
  await fs.writeFile(path.join(fixture, "nested", "sample.txt"), "packaged native helper\n", "utf8");

  const checks = [];
  const add = (pass, name, detail) => checks.push({ pass: Boolean(pass), name, detail });
  await fs.access(executable);
  await fs.access(sourceHelper);
  await fs.access(packagedHelper);
  add(true, "Packaged executable exists", executable);
  add(true, "Bundled helper exists", packagedHelper);

  const [sourceHash, packagedHash] = await Promise.all([sha256(sourceHelper), sha256(packagedHelper)]);
  add(sourceHash === packagedHash, "Bundled helper matches source build", packagedHash);

  const args = ["--smoke", "--smoke-window", "--smoke-native-helper", "--no-updates"];
  const result = await runPackagedApp(args, {
    EXPLORE_BETTER_NATIVE_SMOKE_PATH: fixture,
    EXPLORE_BETTER_USER_DATA_DIR: path.join(appData, "ElectronUserData"),
    EXPLORE_BETTER_WORKSPACE_ROOT: fixture,
    EXPLORE_BETTER_WORKSPACE_LABEL: "Smoke",
    EXPLORE_BETTER_DISABLE_GPU: "1",
    LOCALAPPDATA: appData,
    APPDATA: appData
  });
  const nativeLine = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("Explore Better packaged native helper:")) || "";
  add(result.code === 0 && !result.timedOut && !result.error, "Packaged app exits cleanly", result.error || (result.timedOut ? "Timed out" : `Exit ${result.code}`));
  add(nativeLine.includes("provider=native-go-helper"), "Packaged server uses Go helper", nativeLine || "Missing native helper output");
  add(nativeLine.includes("accuracy=exact"), "Allocated bytes are exact", nativeLine || "Missing native helper output");
  add(nativeLine.includes("source=win32-get-compressed-file-size"), "Win32 allocation source is reported", nativeLine || "Missing native helper output");
  add(/scanned=[1-9]\d*/.test(nativeLine), "Fixture was scanned", nativeLine || "Missing native helper output");

  const failures = checks.filter((item) => !item.pass);
  const report = {
    generatedAt: new Date().toISOString(),
    status: failures.length ? "fail" : "pass",
    executable,
    sourceHelper,
    packagedHelper,
    sourceHash,
    packagedHash,
    args,
    nativeLine,
    checks,
    result
  };
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(latestJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(latestMd, markdown(report), "utf8");
  await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  console.log(`Packaged native helper: ${checks.length - failures.length} pass, ${failures.length} fail`);
  console.log(nativeLine || "Packaged native helper output was missing.");
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
