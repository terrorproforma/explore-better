import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourceDir = path.join(root, "native", "fshelper");
const outputDir = path.join(root, "native", "bin");
const outputPath = path.join(outputDir, process.platform === "win32" ? "explore-better-fs.exe" : "explore-better-fs");

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${file} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  await run("go", ["build", "-buildvcs=false", "-trimpath", "-ldflags", "-s -w", "-o", outputPath, "."], {
    cwd: sourceDir,
    env: { ...process.env, CGO_ENABLED: "0", GOOS: process.platform === "win32" ? "windows" : process.platform, GOARCH: "amd64" }
  });
  const bytes = await fs.readFile(outputPath);
  const report = {
    generatedAt: new Date().toISOString(),
    path: outputPath,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    protocolVersion: 1
  };
  await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
  await fs.writeFile(path.join(root, "artifacts", "native-helper-build-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Built ${outputPath}`);
  console.log(`SHA-256 ${report.sha256}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
