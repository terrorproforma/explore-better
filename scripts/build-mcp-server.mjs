import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceContract = path.join(root, "mcp", "contracts-v1.json");
const moduleDir = path.join(root, "native", "mcpserver");
const generatedContract = path.join(moduleDir, "contracts-v1.json");
const outputDir = path.join(root, "native", "bin");
const output = path.join(outputDir, "ExploreBetterMcp.exe");
const candidateOutput = path.join(outputDir, `ExploreBetterMcp-${process.pid}.tmp.exe`);
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

const contract = await fs.readFile(sourceContract);
JSON.parse(contract.toString("utf8"));
await fs.writeFile(generatedContract, contract);
await fs.mkdir(outputDir, { recursive: true });

const result = spawnSync(
  "go",
  ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${packageJson.version}`, "-o", candidateOutput, "."],
  {
    cwd: moduleDir,
    env: { ...process.env, GOTOOLCHAIN: "go1.25.12" },
    encoding: "utf8",
    windowsHide: true
  }
);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) {
  await fs.rm(candidateOutput, { force: true }).catch(() => {});
  process.exit(result.status || 1);
}

const executable = await fs.readFile(candidateOutput);
let reused = false;
try {
  const existing = await fs.readFile(output);
  reused = existing.equals(executable);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (reused) {
  await fs.rm(candidateOutput, { force: true });
} else {
  await fs.rm(output, { force: true });
  await fs.rename(candidateOutput, output);
}
console.log(
  JSON.stringify({
    output,
    bytes: executable.length,
    sha256: crypto.createHash("sha256").update(executable).digest("hex"),
    contractSha256: crypto.createHash("sha256").update(contract).digest("hex"),
    goToolchain: "go1.25.12",
    reused
  })
);
