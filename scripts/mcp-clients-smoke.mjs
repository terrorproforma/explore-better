import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMcpClientConfigurator } from "../mcp-client-config.mjs";
import { assert, removeTreeEventually, root } from "./mcp-smoke-helpers.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "eb-mcp-clients-"));
try {
  const configurator = createMcpClientConfigurator({
    packaged: false,
    executablePath: path.join(root, "node_modules", "electron", "dist", "electron.exe"),
    appPath: root,
    resourcesPath: path.join(root, "resources"),
    homeDir: path.join(temp, "home"),
    localAppData: path.join(temp, "local"),
    roamingAppData: path.join(temp, "roaming")
  });
  await fs.mkdir(path.dirname(configurator.paths.codex), { recursive: true });
  await fs.writeFile(configurator.paths.codex, "theme = \"dark\"\n\n[mcp_servers.existing]\ncommand = \"existing.exe\"\n");
  await fs.mkdir(path.dirname(configurator.paths.claude), { recursive: true });
  await fs.writeFile(configurator.paths.claude, JSON.stringify({ mcpServers: { existing: { command: "existing.exe" } } }, null, 2));
  await fs.mkdir(path.dirname(configurator.paths.vscode), { recursive: true });
  await fs.writeFile(configurator.paths.vscode, "{\n  // retained comment\n  \"servers\": { \"existing\": { \"command\": \"existing.exe\" } }\n}\n");

  for (const client of ["codex", "claude", "vscode"]) await configurator.install(client, "profile-123");
  const status = await configurator.status();
  assert(status.clients.every((client) => client.installed), "Not all client adapters were installed.");
  await configurator.remove("vscode");
  const vscode = await fs.readFile(configurator.paths.vscode, "utf8");
  assert(vscode.includes("retained comment") && vscode.includes("existing") && !vscode.includes("explore-better"), "VS Code removal changed unrelated configuration.");
  const codex = await fs.readFile(configurator.paths.codex, "utf8");
  const claude = await fs.readFile(configurator.paths.claude, "utf8");
  assert(codex.includes("existing.exe") && codex.includes("explore-better"), "Codex merge lost unrelated configuration.");
  assert(claude.includes("existing.exe") && claude.includes("explore-better"), "Claude merge lost unrelated configuration.");
  assert((await fs.stat(configurator.stableSidecar)).size > 1_000_000, "Stable sidecar deployment is missing.");
  console.log("MCP client setup smoke passed: Codex, Claude, VS Code, atomic sidecar deployment, and non-destructive removal.");
} finally {
  await removeTreeEventually(temp);
}
