import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TOML = require("@iarna/toml");
const { applyEdits, modify, parse, printParseErrorCode } = require("jsonc-parser");
const serverName = "explore-better";

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

function roamingAppData() {
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function readOptional(file) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temp, data, { mode: 0o600 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600).catch(() => {});
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function createMcpClientConfigurator(runtime) {
  const homeDir = runtime.homeDir || os.homedir();
  const localRoot = runtime.localAppData || localAppData();
  const roamingRoot = runtime.roamingAppData || roamingAppData();
  const root = path.join(localRoot, "ExploreBetter", "MCP");
  const binRoot = path.join(root, "bin");
  const backupRoot = path.join(root, "backups");
  const stableSidecar = path.join(binRoot, "ExploreBetterMcp.exe");
  const pendingSidecar = path.join(binRoot, "ExploreBetterMcp.pending.exe");
  const sourceSidecar = runtime.packaged
    ? path.join(runtime.resourcesPath, "native", "ExploreBetterMcp.exe")
    : path.join(runtime.appPath, "native", "bin", "ExploreBetterMcp.exe");
  const paths = {
    codex: path.join(homeDir, ".codex", "config.toml"),
    claude: path.join(roamingRoot, "Claude", "claude_desktop_config.json"),
    vscode: path.join(roamingRoot, "Code", "User", "mcp.json")
  };

  function sidecarArgs(profileId) {
    const args = ["--profile", profileId, "--app", runtime.executablePath];
    if (!runtime.packaged) args.push("--app-dir", runtime.appPath);
    return args;
  }

  function stdioDefinition(client, profileId) {
    const base = { command: stableSidecar, args: sidecarArgs(profileId) };
    return client === "vscode" ? { type: "stdio", ...base } : base;
  }

  async function backup(client, file, existing) {
    if (!existing) return null;
    const dir = path.join(backupRoot, client);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${timestamp()}-${path.basename(file)}.bak`);
    await fs.writeFile(target, existing, { mode: 0o600 });
    return { path: target, sha256: sha256(existing), bytes: existing.length };
  }

  async function deploy() {
    const source = await fs.readFile(sourceSidecar);
    const sourceHash = sha256(source);
    const existing = await readOptional(stableSidecar);
    if (existing && sha256(existing) === sourceHash) {
      return { path: stableSidecar, sha256: sourceHash, bytes: source.length, changed: false, pending: false };
    }
    await fs.mkdir(binRoot, { recursive: true });
    try {
      await atomicWrite(stableSidecar, source);
      await fs.rm(pendingSidecar, { force: true }).catch(() => {});
      return { path: stableSidecar, sha256: sourceHash, bytes: source.length, changed: true, pending: false };
    } catch (error) {
      if (!existing || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      await atomicWrite(pendingSidecar, source);
      return { path: stableSidecar, sha256: sha256(existing), bytes: existing.length, changed: false, pending: true, pendingSha256: sourceHash };
    }
  }

  async function applyPending() {
    const pending = await readOptional(pendingSidecar);
    if (!pending) return false;
    try {
      await atomicWrite(stableSidecar, pending);
      await fs.rm(pendingSidecar, { force: true });
      return true;
    } catch (error) {
      if (["EPERM", "EACCES", "EBUSY"].includes(error.code)) return false;
      throw error;
    }
  }

  function parseJsonc(text, client) {
    const errors = [];
    const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length) {
      throw new Error(`${client} configuration is invalid near byte ${errors[0].offset}: ${printParseErrorCode(errors[0].error)}.`);
    }
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  async function editJsonc(client, profileId, remove = false) {
    const file = paths[client];
    const existing = await readOptional(file);
    const text = existing?.toString("utf8") || "{}\n";
    parseJsonc(text, client);
    const container = client === "claude" ? "mcpServers" : "servers";
    const value = remove ? undefined : stdioDefinition(client, profileId);
    const edits = modify(text, [container, serverName], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" }
    });
    const updated = applyEdits(text, edits);
    const backupRecord = await backup(client, file, existing);
    await atomicWrite(file, Buffer.from(updated, "utf8"));
    return { client, file, installed: !remove, backup: backupRecord };
  }

  async function editCodex(profileId, remove = false) {
    const file = paths.codex;
    const existing = await readOptional(file);
    let document = {};
    if (existing?.length) {
      try {
        document = TOML.parse(existing.toString("utf8"));
      } catch (error) {
        throw new Error(`Codex configuration is invalid TOML: ${error.message}`);
      }
    }
    document.mcp_servers = document.mcp_servers && typeof document.mcp_servers === "object" ? document.mcp_servers : {};
    if (remove) delete document.mcp_servers[serverName];
    else document.mcp_servers[serverName] = stdioDefinition("codex", profileId);
    const backupRecord = await backup("codex", file, existing);
    await atomicWrite(file, Buffer.from(TOML.stringify(document), "utf8"));
    return { client: "codex", file, installed: !remove, backup: backupRecord };
  }

  async function install(client, profileId) {
    if (!["codex", "claude", "vscode"].includes(client)) throw new Error("Unknown MCP client adapter.");
    if (!profileId) throw new Error("Select an AI Bridge profile first.");
    const deployment = await deploy();
    const configuration = client === "codex" ? await editCodex(profileId) : await editJsonc(client, profileId);
    return { deployment, configuration, restartRequired: true };
  }

  async function remove(client) {
    if (!["codex", "claude", "vscode"].includes(client)) throw new Error("Unknown MCP client adapter.");
    return client === "codex" ? editCodex("", true) : editJsonc(client, "", true);
  }

  async function installedStatus(client) {
    const existing = await readOptional(paths[client]);
    if (!existing) return { client, file: paths[client], installed: false };
    try {
      if (client === "codex") {
        const document = TOML.parse(existing.toString("utf8"));
        return { client, file: paths[client], installed: Boolean(document.mcp_servers?.[serverName]) };
      }
      const document = parseJsonc(existing.toString("utf8"), client);
      const container = client === "claude" ? "mcpServers" : "servers";
      return { client, file: paths[client], installed: Boolean(document[container]?.[serverName]) };
    } catch (error) {
      return { client, file: paths[client], installed: false, error: error.message };
    }
  }

  async function status() {
    await applyPending();
    const deployment = await deploy().catch((error) => ({ path: stableSidecar, error: error.message, pending: false }));
    return {
      deployment,
      clients: await Promise.all(["codex", "claude", "vscode"].map(installedStatus)),
      generic: { command: stableSidecar, args: ["--profile", "PROFILE_ID", "--app", runtime.executablePath, ...(runtime.packaged ? [] : ["--app-dir", runtime.appPath])] }
    };
  }

  return { deploy, install, remove, status, paths, stableSidecar, sourceSidecar };
}
