import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMcpClientConfigurator } from "../mcp-client-config.mjs";
import { replaceTomlServer, writeClientConfigIfUnchanged } from "../mcp/config-file.mjs";
import { assert, removeTreeEventually, root } from "./mcp-smoke-helpers.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "eb-mcp-clients-"));
try {
  const runtime = {
    packaged: false,
    executablePath: path.join(root, "node_modules", "electron", "dist", "electron.exe"),
    appPath: root,
    resourcesPath: path.join(root, "resources"),
    homeDir: path.join(temp, "home"),
    localAppData: path.join(temp, "local"),
    roamingAppData: path.join(temp, "roaming")
  };
  const configurator = createMcpClientConfigurator(runtime);
  await fs.mkdir(path.dirname(configurator.paths.codex), { recursive: true });
  const originalCodex = '# User preference comment\r\ntheme = "dark"\r\nnotes = """Literal table syntax:\r\n[mcp_servers.explore-better]\r\nkept as text\r\n"""\r\n\r\n# Existing integration comment\r\n[mcp_servers.existing]\r\ncommand = "existing.exe" # Keep this comment\r\n';
  await fs.writeFile(configurator.paths.codex, originalCodex);
  await fs.mkdir(path.dirname(configurator.paths.claude), { recursive: true });
  await fs.writeFile(configurator.paths.claude, JSON.stringify({ mcpServers: { existing: { command: "existing.exe" } } }, null, 2));
  await fs.mkdir(path.dirname(configurator.paths.vscode), { recursive: true });
  await fs.writeFile(configurator.paths.vscode, "{\n  // retained comment\n  \"servers\": { \"existing\": { \"command\": \"existing.exe\" } }\n}\n");
  await fs.mkdir(path.dirname(configurator.paths.cursor), { recursive: true });
  await fs.writeFile(configurator.paths.cursor, "{\n  // retained Cursor comment\n  \"mcpServers\": { \"existing\": { \"command\": \"existing.exe\" } }\n}\n");

  for (const client of ["codex", "claude", "cursor", "vscode"]) await configurator.install(client, "profile-123");
  const status = await configurator.status();
  assert(status.clients.every((client) => client.installed), "Not all client adapters were installed.");
  await configurator.remove("vscode");
  const vscode = await fs.readFile(configurator.paths.vscode, "utf8");
  assert(vscode.includes("retained comment") && vscode.includes("existing") && !vscode.includes("explore-better"), "VS Code removal changed unrelated configuration.");
  await configurator.remove("cursor");
  const cursor = await fs.readFile(configurator.paths.cursor, "utf8");
  assert(cursor.includes("retained Cursor comment") && cursor.includes("existing") && !cursor.includes("explore-better"), "Cursor removal changed unrelated configuration.");
  const codex = await fs.readFile(configurator.paths.codex, "utf8");
  const claude = await fs.readFile(configurator.paths.claude, "utf8");
  assert(codex.includes("existing.exe") && codex.includes("explore-better"), "Codex merge lost unrelated configuration.");
  assert(codex.startsWith(originalCodex), "Codex setup changed existing comments, strings, line endings, or formatting.");
  await configurator.install("codex", "profile-123");
  assert(await fs.readFile(configurator.paths.codex, "utf8") === codex, "Repeated Codex setup must be a no-op.");
  await Promise.all([configurator.install("codex", "profile-456"), configurator.install("codex", "profile-789")]);
  const concurrent = await fs.readFile(configurator.paths.codex, "utf8");
  assert(concurrent.startsWith(originalCodex) && concurrent.includes("profile-789"), "Concurrent adapter edits must serialize without losing unrelated settings.");

  // Hold the older install's deployment while making later sidecar reads
  // resolve immediately. This exercises the ordering race without disk-speed
  // assumptions or a production-only test hook.
  async function withDelayedDeployment(actions, { failFirst = false } = {}) {
    const readFile = fs.readFile;
    const sourceBytes = await readFile(configurator.sourceSidecar);
    const installedBytes = await readFile(configurator.stableSidecar);
    let release;
    let started;
    let sourceReads = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const firstStarted = new Promise(resolve => { started = resolve; });
    fs.readFile = async function(file, ...args) {
      if (file === configurator.sourceSidecar) {
        sourceReads += 1;
        if (sourceReads === 1) {
          started();
          await gate;
          if (failFirst) throw new Error("Injected deployment read failure");
        }
        return Buffer.from(sourceBytes);
      }
      if (file === configurator.stableSidecar) return Buffer.from(installedBytes);
      return readFile.call(this, file, ...args);
    };
    let pending;
    try {
      pending = Promise.allSettled(actions.map(action => action()));
      await firstStarted;
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      release();
      return await pending;
    } finally {
      release();
      await pending;
      fs.readFile = readFile;
    }
  }

  const secondConfigurator = createMcpClientConfigurator(runtime);
  for (const client of ["codex", "claude", "cursor", "vscode"]) {
    const outcomes = await withDelayedDeployment([
      () => configurator.install(client, `older-${client}`),
      () => secondConfigurator.install(client, `newer-${client}`)
    ]);
    assert(outcomes.every(item => item.status === "fulfilled"), `${client} concurrent installs failed.`);
    const contents = await fs.readFile(configurator.paths[client], "utf8");
    assert(contents.includes(`newer-${client}`) && !contents.includes(`older-${client}`), `${client} installs did not retain invocation order across configurator instances.`);
    assert(contents.includes("existing.exe"), `${client} concurrent installs lost unrelated settings.`);
    if (client === "codex") assert(contents.startsWith(originalCodex), "Delayed Codex installs changed unrelated formatting.");
    if (client === "cursor" || client === "vscode") assert(contents.includes("retained"), `${client} concurrent installs lost comments.`);
  }

  const removedAfterInstall = await withDelayedDeployment([
    () => configurator.install("codex", "must-be-removed"),
    () => secondConfigurator.remove("codex")
  ]);
  assert(removedAfterInstall.every(item => item.status === "fulfilled"), "Concurrent install/removal failed.");
  let ordered = await fs.readFile(configurator.paths.codex, "utf8");
  assert(ordered.startsWith(originalCodex) && !ordered.includes("must-be-removed") && !ordered.includes("newer-codex"), "A delayed install resurrected an integration after removal.");

  const installedAfterRemove = await withDelayedDeployment([
    () => configurator.remove("codex"),
    () => secondConfigurator.install("codex", "installed-after-removal")
  ]);
  assert(installedAfterRemove.every(item => item.status === "fulfilled"), "Concurrent removal/install failed.");
  ordered = await fs.readFile(configurator.paths.codex, "utf8");
  assert(ordered.startsWith(originalCodex) && ordered.includes("installed-after-removal"), "A newer install was lost after a removal.");

  const recoveredQueue = await withDelayedDeployment([
    () => configurator.install("codex", "failed-deployment"),
    () => secondConfigurator.install("codex", "queue-recovered")
  ], { failFirst: true });
  assert(recoveredQueue[0].status === "rejected" && recoveredQueue[1].status === "fulfilled", "Failed deployment poisoned the queued edit chain.");
  ordered = await fs.readFile(configurator.paths.codex, "utf8");
  assert(ordered.startsWith(originalCodex) && ordered.includes("queue-recovered") && !ordered.includes("failed-deployment"), "Queue recovery lost unrelated settings or installed the failed profile.");

  await configurator.install("codex", "profile-789");
  await configurator.remove("codex");
  const removedCodex = await fs.readFile(configurator.paths.codex, "utf8");
  assert(removedCodex.startsWith(originalCodex) && !removedCodex.includes("profile-789"), "Codex removal changed unrelated comments or multiline strings.");
  const nested = '[mcp_servers."explore-better"]\ncommand = "old.exe"\n[mcp_servers."explore-better".env]\nSETTING = "value"\n\n# A different integration\n[mcp_servers.other]\ncommand = "other.exe"\n';
  const replaced = replaceTomlServer(nested, "explore-better", { command: "new.exe", args: [] });
  assert(replaced.includes('# A different integration\n[mcp_servers.other]\ncommand = "other.exe"') && !replaced.includes('SETTING = "value"'), "Replacing a server table failed to preserve unrelated sections or remove its own nested table.");
  const collisionFile = path.join(temp, "concurrent-config.json");
  const before = Buffer.from('{"version":1}\n');
  const externalEdit = Buffer.from('{"version":2,"userEdit":true}\n');
  await fs.writeFile(collisionFile, externalEdit);
  let conflict;
  try { await writeClientConfigIfUnchanged(collisionFile, Buffer.from('{"version":3}\n'), before); } catch (error) { conflict = error; }
  assert(conflict?.code === "CONFIG_CHANGED" && (await fs.readFile(collisionFile)).equals(externalEdit), "Client setup overwrote a concurrent file edit.");
  assert(!(await fs.readdir(temp)).some((name) => name.endsWith(".tmp")), "Failed configuration commits left temporary files behind.");
  assert(claude.includes("existing.exe") && claude.includes("explore-better"), "Claude merge lost unrelated configuration.");
  assert((await fs.stat(configurator.stableSidecar)).size > 1_000_000, "Stable sidecar deployment is missing.");
  console.log("MCP client setup smoke passed: four adapters, seven delayed-deployment order cases, comment-preserving TOML/JSONC edits, concurrent-edit detection, idempotence, sidecar deployment, and non-destructive removal.");
} finally {
  await removeTreeEventually(temp);
}
