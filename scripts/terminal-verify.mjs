import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const electron = path.join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");

function stopTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else process.kill(pid, "SIGKILL");
}

function run(label, command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    console.log(`\n[terminal] ${label}`);
    const child = spawn(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
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
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code}.`));
    });
  });
}

await run("renderer build", process.execPath, ["scripts/build-terminal.mjs"], 30000);
await run("real ConPTY", electron, [".", "--smoke", "--smoke-window", "--smoke-terminal"], 60000);
await run("hostile IPC", electron, [".", "--smoke", "--smoke-window", "--smoke-terminal-security"], 60000);
await run("per-tab UI", process.execPath, ["scripts/terminal-ui-smoke.mjs"], 120000);
console.log("\nTerminal verification passed.");
