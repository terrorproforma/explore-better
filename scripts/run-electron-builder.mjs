import { spawn, spawnSync } from "node:child_process";
import { access, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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

let fallback = null;
try {
  fallback = await prepareCollectorFallback();
  const env = { ...process.env };
  if (fallback) {
    env.npm_config_user_agent = "traversal electron-builder-fallback";
    env.npm_execpath = "traversal";
  }
  const code = await run(process.execPath, [electronBuilderCli, ...process.argv.slice(2)], { env });
  process.exitCode = code;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (fallback?.createdHint) await rm(fallback.hintPath, { force: true });
}
