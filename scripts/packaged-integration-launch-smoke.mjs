import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

const workspace = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(workspace, "artifacts", `packaged-integration-launch-${stamp}`);
const localAppData = path.join(runRoot, "LocalAppData");
const roamingAppData = path.join(runRoot, "RoamingAppData");
const desktopExecutable = path.join(runRoot, "Programs", "Explore Better", "Explore Better.exe");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const selected = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}

async function requestJson(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      ...(options.method && options.method !== "GET" ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

await fs.mkdir(path.dirname(desktopExecutable), { recursive: true });
await fs.mkdir(localAppData, { recursive: true });
await fs.mkdir(roamingAppData, { recursive: true });
await fs.writeFile(desktopExecutable, "packaged executable fixture\n");

const port = await availablePort();
process.env.HOST = "127.0.0.1";
process.env.PORT = String(port);
process.env.LOCALAPPDATA = localAppData;
process.env.APPDATA = roamingAppData;
const baseUrl = `http://127.0.0.1:${port}`;
const backend = await import("../server.mjs");
backend.setDesktopExecutablePath(desktopExecutable);

try {
  await backend.startServer();
  const generated = await requestJson(baseUrl, "/api/integration/generate", { method: "POST" });
  const folderDefault = await fs.readFile(generated.folderDefaultRegPath, "utf8");
  const launcher = await fs.readFile(generated.scriptPath, "utf8");
  const shortcuts = await fs.readFile(generated.shortcutScriptPath, "utf8");
  const escapedExecutable = desktopExecutable.replaceAll("\\", "\\\\");

  assert(folderDefault.includes(escapedExecutable), "The default folder handler did not target the packaged desktop executable.");
  assert(!folderDefault.includes("powershell.exe"), "The packaged default folder handler still routes through PowerShell.");
  assert(launcher.includes(`$DesktopApp = "${escapedExecutable}"`), "The fallback launcher did not retain the packaged executable.");
  assert(shortcuts.includes(`$DesktopApp = "${escapedExecutable}"`), "Generated shortcuts did not retain the packaged executable.");
  assert(shortcuts.includes("$shortcut.TargetPath = $DesktopApp"), "Generated shortcuts do not launch the packaged executable directly.");
  console.log("Packaged integration launch smoke passed: default handlers and shortcuts use the desktop executable directly.");
} finally {
  await backend.stopServer();
  await fs.rm(runRoot, { recursive: true, force: true });
}

process.exit(0);
