import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `desktop-backend-recovery-${stamp}`);
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "desktop-backend-recovery-latest.json");
const latestMdPath = path.join(artifactsDir, "desktop-backend-recovery-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function randomPort() {
  return 57000 + Math.floor(Math.random() * 6000);
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_DESKTOP_BACKEND_KEEP_FIXTURE === "1";
}

function limitedAppend(current, chunk, limit = 32000) {
  const next = current + chunk.toString();
  return next.length <= limit ? next : next.slice(next.length - limit);
}

function runCommand(command, args, { timeoutMs = 90000, env = {} } = {}) {
  return new Promise((resolve) => {
    let child = null;
    let stdout = "";
    let stderr = "";
    let settled = false;
    try {
      child = spawn(command, args, {
        cwd: workspace,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      resolve({ code: null, error: error.message, stdout, stderr });
      return;
    }
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: null, timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = limitedAppend(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = limitedAppend(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code: null, error: error.message, stdout, stderr });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseRecovery(stdout) {
  const line = stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith("Explore Better backend recovery: before="));
  if (!line) return null;
  const data = {};
  for (const match of line.matchAll(/([A-Za-z]+)=([^ ]+)/g)) {
    data[match[1]] = match[2];
  }
  return {
    line,
    before: data.before === "true",
    rendererBefore: data.rendererBefore === "true",
    simulated: data.simulated || "",
    down: data.down === "true",
    after: data.after === "true",
    rendererAfter: data.rendererAfter === "true",
    rows: Number(data.rows || 0),
    restarts: Number(data.restarts || 0)
  };
}

function check(status, id, label, detail, data = {}) {
  return { status, id, label, detail, ...data };
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.label} | ${String(item.detail || "").replaceAll("|", "\\|")} |`)
    .join("\n");
  return `# Explore Better Desktop Backend Recovery

Generated: ${report.generatedAt}

Status: ${report.status}

Port: ${report.port}

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Recovery Line

\`${report.recovery?.line || "missing"}\`

## Command

\`${report.command} ${report.args.join(" ")}\`
`;
}

async function main() {
  await fs.mkdir(appData, { recursive: true });
  await fs.mkdir(artifactsDir, { recursive: true });
  const port = Number(optionValue("--port", process.env.PORT || randomPort()));
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "npm run desktop:smoke-backend-restart"]
      : ["run", "desktop:smoke-backend-restart"];
  const result = await runCommand(command, args, {
    timeoutMs: Number(optionValue("--timeout-ms", process.env.EB_DESKTOP_BACKEND_TIMEOUT_MS || "90000")),
    env: {
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData,
      EXPLORE_BETTER_USER_DATA_DIR: path.join(appData, "ElectronUserData"),
      EXPLORE_BETTER_BACKEND_WATCHDOG_MS: "500"
    }
  });
  const recovery = parseRecovery(result.stdout);
  const checks = [];
  checks.push(
    check(
      result.code === 0 && !result.timedOut && !result.error ? "pass" : "fail",
      "desktop-smoke-exit",
      "Desktop backend recovery smoke exits cleanly",
      result.timedOut ? "Timed out." : result.error || `Exit ${result.code}.`
    )
  );
  checks.push(
    check(
      result.stdout.includes("Explore Better backend bridge: ready") ? "pass" : "fail",
      "backend-bridge",
      "Backend bridge is exposed",
      result.stdout.includes("Explore Better backend bridge: ready") ? "Bridge ready." : "Missing backend bridge ready output."
    )
  );
  checks.push(
    check(
      recovery?.before && recovery?.rendererBefore ? "pass" : "fail",
      "backend-before",
      "Backend and renderer start healthy",
      recovery ? `before=${recovery.before}, rendererBefore=${recovery.rendererBefore}` : "Missing recovery line."
    )
  );
  checks.push(
    check(
      Boolean(recovery?.simulated && recovery?.simulated !== "none" && recovery?.down) ? "pass" : "fail",
      "backend-simulated-failure",
      "Smoke proves backend can go down",
      recovery ? `simulated=${recovery.simulated}, down=${recovery.down}` : "Missing recovery line."
    )
  );
  checks.push(
    check(
      recovery?.after && recovery?.rendererAfter && recovery?.rows > 0 && recovery?.restarts >= 1 ? "pass" : "fail",
      "backend-recovered",
      "Desktop recovers backend and reloads renderer",
      recovery
        ? `after=${recovery.after}, rendererAfter=${recovery.rendererAfter}, rows=${recovery.rows}, restarts=${recovery.restarts}`
        : "Missing recovery line."
    )
  );
  const failures = checks.filter((item) => item.status === "fail");
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    runRoot,
    appData,
    port,
    status: failures.length ? "fail" : "pass",
    command,
    args,
    checks,
    recovery,
    result: {
      code: result.code,
      timedOut: Boolean(result.timedOut),
      error: result.error || null,
      stdout: result.stdout,
      stderr: result.stderr
    }
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  if (!keepFixture()) {
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`desktop backend recovery: ${report.status} (${checks.length - failures.length}/${checks.length} checks passed)`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (failures.length) {
    console.error(`failures: ${failures.map((item) => `${item.id}: ${item.detail}`).join("; ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
