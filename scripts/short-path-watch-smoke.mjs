import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// libuv aborts the process when an fs.watch target is an 8.3 short path and
// events arrive under the long name. Browsing or storing app data through a
// short alias must never take the backend down.
const root = path.resolve(import.meta.dirname, "..");

function shortPathOf(target) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${target.replaceAll("'", "''")}').ShortPath`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.platform !== "win32") {
  console.log("Short-path watch smoke: skipped (Windows only).");
  process.exit(0);
}

const base = await fs.mkdtemp(path.join(os.tmpdir(), "eb-short-path-"));
const longFolder = path.join(base, "Long Folder Name For Watching");
const longAppData = path.join(base, "Long Application Data Folder");
await fs.mkdir(longFolder, { recursive: true });
await fs.mkdir(longAppData, { recursive: true });
const shortFolder = shortPathOf(longFolder);
const shortAppData = shortPathOf(longAppData);
if (!shortFolder || shortFolder === longFolder || !shortAppData || shortAppData === longAppData) {
  console.log("Short-path watch smoke: skipped (8.3 names are disabled on this volume).");
  await fs.rm(base, { recursive: true, force: true });
  process.exit(0);
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const output = [];
const child = spawn(process.execPath, [path.join(root, "server.mjs")], {
  cwd: root,
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: shortAppData, APPDATA: shortAppData },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
child.stdout.on("data", (chunk) => output.push(String(chunk)));
child.stderr.on("data", (chunk) => output.push(String(chunk)));
const request = async (route) => {
  const response = await fetch(`${baseUrl}${route}`, { headers: { host: `127.0.0.1:${port}` } });
  return response.json();
};
try {
  for (let attempt = 0; ; attempt += 1) {
    try { await request("/api/roots"); break; } catch (error) {
      if (attempt > 150 || child.exitCode !== null) throw error;
      await delay(100);
    }
  }
  // Watch the folder through its short alias, then change it and the app data
  // folder so both the listing watcher and the state watcher receive events.
  await request(`/api/list?${new URLSearchParams({ path: shortFolder })}`);
  const first = await request(`/api/folder-watch?${new URLSearchParams({ path: shortFolder })}`);
  await fs.writeFile(path.join(longFolder, "changed.txt"), "change");
  await fs.writeFile(path.join(longAppData, "ExploreBetter", "probe.txt"), "probe").catch(() => {});
  await delay(1500);
  assert.equal(child.exitCode, null, `Backend exited after short-path watch events:\n${output.join("")}`);
  const second = await request(`/api/folder-watch?${new URLSearchParams({ path: shortFolder, since: String(first.version ?? 0) })}`);
  assert.ok(second, "Folder watch should still answer after events.");
  console.log(`PASS backend survives watch events on 8.3 paths (${shortFolder})`);
} finally {
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  await delay(200);
  await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}
