import os from "node:os";
import path from "node:path";

export function roamingAppDataRoot() {
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

// Client configuration files that Explore Better's MCP setup manages. Shared by
// the configurator and the MCP write policy, which never lets an AI client
// rewrite the files that decide which MCP servers it launches.
export function mcpClientConfigPaths({ homeDir = os.homedir(), roamingAppData = roamingAppDataRoot() } = {}) {
  return {
    codex: path.join(homeDir, ".codex", "config.toml"),
    claude: path.join(roamingAppData, "Claude", "claude_desktop_config.json"),
    cursor: path.join(homeDir, ".cursor", "mcp.json"),
    vscode: path.join(roamingAppData, "Code", "User", "mcp.json")
  };
}

// Folders whose contents Windows runs at sign-in.
export function windowsStartupFolders({ roamingAppData = roamingAppDataRoot(), programData = process.env.ProgramData || "C:\\ProgramData" } = {}) {
  return [
    path.join(roamingAppData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
    path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs", "StartUp")
  ];
}
