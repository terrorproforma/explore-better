import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const mcpDir = path.join(localAppData, "ExploreBetter", "MCP");
const manifestPath = path.resolve(optionValue("--manifest", path.join(mcpDir, "bridge-v1.json")));
const configPath = path.resolve(optionValue("--config", path.join(mcpDir, "bridge-config.json")));
const requestedProfile = optionValue("--profile");
const requestedView = optionValue("--view");
const viewVisible = !process.argv.includes("--close");
const summaryOnly = process.argv.includes("--summary");
const timeoutMs = Math.max(1000, Number(optionValue("--timeout", "15000")) || 15000);

const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const profile = (config.profiles || []).find((item) =>
  item.enabled &&
  item.tools?.includes("get_context") &&
  (!requestedProfile || item.id === requestedProfile || item.name === requestedProfile)
);
if (!profile) {
  throw new Error(requestedProfile ? `No enabled get_context profile matched ${requestedProfile}.` : "No enabled get_context profile is configured.");
}
if (requestedView && !profile.tools?.includes("set_ui_view")) {
  throw new Error(`Profile ${profile.name || profile.id} does not permit set_ui_view.`);
}

const executable = path.join(process.cwd(), "native", "bin", "ExploreBetterMcp.exe");
const sidecar = spawn(executable, ["--profile", profile.id, "--manifest", manifestPath], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true
});
const lines = readline.createInterface({ input: sidecar.stdout });
const pending = new Map();
let nextId = 1;
let stderr = "";
let closing = false;

sidecar.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

function write(message) {
  if (closing || sidecar.exitCode !== null || sidecar.stdin.destroyed || !sidecar.stdin.writable) {
    throw new Error(`MCP sidecar is not writable. ${stderr}`.trim());
  }
  sidecar.stdin.write(`${JSON.stringify(message)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "ping" && message.id !== undefined) {
    write({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  const record = pending.get(String(message.id));
  if (!record) return;
  pending.delete(String(message.id));
  record.resolve(message);
});

function call(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(String(id));
      reject(new Error(`MCP ${method} timed out after ${timeoutMs} ms. ${stderr}`.trim()));
    }, timeoutMs);
    pending.set(String(id), {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      }
    });
    try {
      write({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(String(id));
      reject(error);
    }
  });
}

function contextSummary(content) {
  const data = content?.data || {};
  return {
    status: content?.status || "unknown",
    schemaVersion: content?.schemaVersion || "",
    contextRevision: content?.contextRevision || data.contextRevision || 0,
    live: data.live === true,
    activePane: data.activePane || "",
    paneLayout: data.paneLayout || "",
    paneAuthorization: Object.fromEntries(
      Object.entries(data.panes || {}).map(([paneName, pane]) => [
        paneName,
        {
          pathAuthorized: pane.pathAuthorized === true,
          tabCount: Array.isArray(pane.tabs) ? pane.tabs.length : 0,
          authorizedTabs: Array.isArray(pane.tabs) ? pane.tabs.filter((tab) => tab.pathAuthorized === true).length : 0
        }
      ])
    ),
    selectionCount: Array.isArray(data.selection) ? data.selection.length : 0,
    statusText: data.ui?.status || "",
    toast: data.ui?.toast || null,
    openDialogs: data.ui?.openDialogs || [],
    lastInteraction: data.ui?.lastInteraction || null,
    navigator: data.ui?.navigator || null,
    terminals: data.ui?.terminals || [],
    warnings: content?.warnings || []
  };
}

try {
  const initialized = await call("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "Explore Better live context inspector", version: "1" }
  });
  if (initialized.error) throw new Error(`MCP initialize failed: ${JSON.stringify(initialized.error)}`);
  write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  let viewAction = null;
  if (requestedView) {
    const actionResponse = await call("tools/call", {
      name: "set_ui_view",
      arguments: { view: requestedView, visible: viewVisible }
    });
    if (actionResponse.error || actionResponse.result?.isError) {
      throw new Error(`MCP set_ui_view failed: ${JSON.stringify(actionResponse.error || actionResponse.result)}`);
    }
    viewAction = actionResponse.result?.structuredContent || actionResponse.result;
  }
  const response = await call("tools/call", { name: "get_context", arguments: {} });
  if (response.error) throw new Error(`MCP get_context failed: ${JSON.stringify(response.error)}`);
  const content = response.result?.structuredContent || response.result;
  const output = summaryOnly ? contextSummary(content) : content;
  console.log(JSON.stringify(viewAction ? { viewAction, context: output } : output, null, 2));
} finally {
  closing = true;
  lines.close();
  sidecar.kill();
}
