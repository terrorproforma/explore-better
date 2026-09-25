import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { azureSigningConfig } from "./azure-signing-config.mjs";

const root = path.resolve(import.meta.dirname, "..");
const electronBuilderCli = path.join(root, "node_modules", "electron-builder", "out", "cli", "cli.js");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: false,
      ...options
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${path.basename(command)} stopped with ${signal}.`));
      else resolve(code ?? 1);
    });
  });
}

function commandIsAvailable(command) {
  const result = spawnSync(command, ["--version"], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true
  });
  return result.status === 0;
}

function npmIsAvailable() {
  if (process.platform !== "win32") return commandIsAvailable("npm");
  const result = spawnSync("where.exe", ["npm"], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true
  });
  return result.status === 0;
}

async function pathExists(file) {
  return access(file).then(
    () => true,
    () => false
  );
}

async function prepareCollectorFallback() {
  if (npmIsAvailable()) return null;
  const hintPath = path.join(root, "pnpm-lock.yaml");
  const createdHint = !(await pathExists(hintPath));

  // electron-builder prioritizes lockfiles over its package-manager environment hint.
  // A second temporary hint makes lockfile detection intentionally ambiguous, allowing
  // the explicit environment below to select its package-manager-independent traversal.
  if (createdHint) await writeFile(hintPath, "lockfileVersion: '9.0'\n");

  console.log("npm was not found; using electron-builder's package-manager-independent dependency traversal.");
  return { hintPath, createdHint };
}

// The package excludes the raw renderer sources and ships only the esbuild output,
// and extraResources copies the native helpers. Refuse to build an app without them.
const requiredBuildOutputs = [
  "public/generated/app-runtime.js",
  "public/generated/model-runtime.js",
  "public/generated/model-worker.js",
  "public/generated/terminal-renderer.js",
  "native/bin/explore-better-fs.exe",
  "native/bin/ExploreBetterMcp.exe"
];

async function assertBuildOutputs() {
  const missing = [];
  for (const relative of requiredBuildOutputs) {
    if (!(await pathExists(path.join(root, relative)))) missing.push(relative);
  }
  if (missing.length) {
    throw new Error(`Missing build output: ${missing.join(", ")}. Run the prepackage steps (build:renderer, build:native-helper, build:mcp-server) first.`);
  }
}

// Signing is opt-in (see docs/CODE_SIGNING.md). The signing options are written to a
// temporary parent configuration that package.json's "build" field extends, so arrays
// and booleans keep their JSON types and an unconfigured build passes no extra argument.
async function prepareSigningArguments() {
  const signing = azureSigningConfig();
  if (!signing) return { args: [], dir: null };
  const dir = await mkdtemp(path.join(os.tmpdir(), "eb-signing-config-"));
  const file = path.join(dir, "electron-builder.signing.json");
  await writeFile(file, `${JSON.stringify(signing, null, 2)}\n`, "utf8");
  const { endpoint, codeSigningAccountName, certificateProfileName } = signing.win.azureSignOptions;
  console.log(`Azure Artifact Signing enabled: account ${codeSigningAccountName}, profile ${certificateProfileName}, endpoint ${endpoint}.`);
  return { args: [`--config.extends=file:${file}`], dir };
}

let fallback = null;
let signingDir = null;
try {
  const signingArguments = await prepareSigningArguments();
  signingDir = signingArguments.dir;
  await assertBuildOutputs();
  fallback = await prepareCollectorFallback();
  const env = { ...process.env };
  if (fallback) {
    env.npm_config_user_agent = "traversal electron-builder-fallback";
    env.npm_execpath = "traversal";
  }
  const code = await run(process.execPath, [electronBuilderCli, ...process.argv.slice(2), ...signingArguments.args], { env });
  process.exitCode = code;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (fallback?.createdHint) await rm(fallback.hintPath, { force: true });
  if (signingDir) await rm(signingDir, { recursive: true, force: true });
}
