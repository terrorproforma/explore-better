import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { after, before, test } from "node:test";
import vm from "node:vm";
import { cmdQuote, powerShellLiteral } from "../lib/shell-quote.mjs";

// Runs the production quoting and process helpers (sliced from server.mjs and
// app.js) against real powershell.exe, cmd.exe and C-runtime argv parsing.
const root = path.resolve(import.meta.dirname, "..");
const serverSource = (await fs.readFile(path.join(root, "server.mjs"), "utf8")).replaceAll("\r\n", "\n");
const appSource = (await fs.readFile(path.join(root, "public", "app.js"), "utf8")).replaceAll("\r\n", "\n");
const windows = process.platform === "win32";

function topLevelFunction(source, name) {
  const match = new RegExp(`\\n(async )?function ${name}\\(`).exec(source);
  assert.ok(match, `missing function ${name}`);
  const start = match.index + 1;
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 3);
}

function topLevelConst(source, name) {
  const start = source.indexOf(`\nconst ${name} = `);
  assert.ok(start >= 0, `missing const ${name}`);
  return source.slice(start + 1, source.indexOf(";\n", start) + 2);
}

let tempDir;
let context;

before(async () => {
  // Canonicalize so 8.3 short TEMP paths (e.g. CI's RUNNER~1) match what PowerShell reports.
  tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "eb-shell-quoting-")));
  context = vm.createContext({
    Buffer, StringDecoder, spawn, crypto, fs, path, process, setTimeout, clearTimeout, Promise, Error, Number, String, JSON,
    cmdQuote,
    quotePowerShellLiteral: powerShellLiteral,
    tempRoot: path.join(tempDir, "payloads"),
    resolveUserPath: (value) => path.resolve(String(value))
  });
  const constants = ["powerShellUtf8Prelude", "processCloseGraceMs"].map((name) => topLevelConst(serverSource, name));
  const functions = [
    "isStateRecord", "sanitizeCommand", "powerShellUtf8Output", "runPowerShellPayload", "spawnDetachedStarted", "cmdCommandLine",
    "launchDetached", "windowsTerminalDirectoryArguments", "killProcessTree", "boundedOutputCollector", "runProcess",
    "shellQuote", "applyCommandTemplate", "limitedAppend", "runExternalCommand"
  ].map((name) => topLevelFunction(serverSource, name));
  vm.runInContext([...constants, ...functions, topLevelFunction(appSource, "shellQuoteDroppedPath")].join("\n"), context);
});

after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const trickyNames = [
  "C:\\Temp\\plain.txt",
  "C:\\Temp\\it's here.txt",
  "C:\\Temp\\a’; Write-Output INJECTED; ’b.txt",
  "C:\\Temp\\‘left’ ‚low‛.txt",
  "C:\\Temp\\$env:USERNAME $(Write-Output INJECTED) `n.txt",
  "C:\\Temp\\100% %PATH% & echo INJECTED ^ | (1).txt",
  "C:\\Temp\\José résumé 日本.txt",
  "C:\\Temp\\trailing dir\\"
];

test("renderer drop quoting matches the shared helpers", () => {
  for (const name of trickyNames) {
    assert.equal(context.shellQuoteDroppedPath("windows-powershell", name), powerShellLiteral(name));
    assert.equal(context.shellQuoteDroppedPath("powershell7", name), powerShellLiteral(name));
    assert.equal(context.shellQuoteDroppedPath("command-prompt", name), cmdQuote(name));
  }
  assert.equal(context.shellQuote("a’b", "powershell"), "'a’’b'");
  assert.equal(context.shellQuote("50%", "cmd"), cmdQuote("50%"));
});

async function runCommand(kind, command, selectedPaths = trickyNames) {
  return context.runExternalCommand({ id: "test", name: "quoting", kind, command }, {
    activePath: selectedPaths[0],
    otherPath: selectedPaths.at(-1),
    selectedPaths,
    cwd: tempDir
  });
}

test("PowerShell custom commands round-trip tricky names without injection", { skip: !windows }, async () => {
  const { result } = await runCommand("powershell", "ConvertTo-Json -Compress -InputObject @(& { $args } {selected} {active} {other})");
  assert.doesNotMatch(result.stdout, /^INJECTED/m);
  assert.deepEqual(JSON.parse(result.stdout), [...trickyNames, trickyNames[0], trickyNames.at(-1)]);
});

test("cmd custom commands round-trip tricky names through quoted programs", { skip: !windows }, async () => {
  const echo = path.join(tempDir, "echo args.cjs");
  await fs.writeFile(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const { result } = await runCommand("cmd", `${cmdQuote(process.execPath)} ${cmdQuote(echo)} {selected} {first}`);
  assert.doesNotMatch(result.stdout, /^INJECTED/m);
  assert.deepEqual(JSON.parse(result.stdout), [...trickyNames, trickyNames[0]]);
});

test("runPowerShellPayload returns non-ASCII output as UTF-8", { skip: !windows }, async () => {
  const dir = path.join(tempDir, "José résumé 日本 ’q");
  const file = path.join(dir, "Ünïcødé ‘名前’.txt");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, "x");
  const script = `param([string]$PayloadPath)
$ErrorActionPreference = "Stop"
$Payload = Get-Content -Raw -LiteralPath $PayloadPath -Encoding UTF8 | ConvertFrom-Json
[pscustomobject]@{ path = (Get-Item -LiteralPath ([string]$Payload.path)).FullName; name = "Ωmega …" } | ConvertTo-Json -Compress
`;
  for (const sta of [false, true]) {
    const result = await context.runPowerShellPayload(script, { path: file }, { sta, timeoutMs: 60_000 });
    assert.deepEqual(JSON.parse(result.stdout.trim()), { path: file, name: "Ωmega …" });
  }
  const bare = await context.runPowerShellPayload("Write-Output 'Grüße 日本'", {}, { timeoutMs: 60_000 });
  assert.equal(bare.stdout.trim(), "Grüße 日本");
  const failure = await context.runPowerShellPayload("throw 'fehlgeschlagen: ü'", {}, { timeoutMs: 60_000 }).catch((error) => error);
  assert.match(failure.message, /fehlgeschlagen: ü/);
  assert.deepEqual(await fs.readdir(context.tempRoot), []);
});

test("runPowerShellPayload timeouts kill the whole process tree", { skip: !windows }, async () => {
  const pidFile = path.join(tempDir, "grandchild.pid");
  const script = `param([string]$PayloadPath)
$Payload = Get-Content -Raw -LiteralPath $PayloadPath -Encoding UTF8 | ConvertFrom-Json
$Child = Start-Process powershell.exe -ArgumentList "-NoProfile", "-Command", "Start-Sleep 120" -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $Payload.pidFile -Value $Child.Id
Start-Sleep 120
`;
  const started = Date.now();
  const deadline = Date.now() + 15_000;
  const pending = context.runPowerShellPayload(script, { pidFile }, { timeoutMs: 6000 });
  await assert.rejects(pending, /timed out after 6000ms/);
  assert.ok(Date.now() - started < 20_000);
  const pid = Number((await fs.readFile(pidFile, "utf8")).trim());
  assert.ok(pid > 0);
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch {
      alive = false;
    }
  }
  if (alive) process.kill(pid);
  assert.equal(alive, false, "grandchild survived the timeout");
});

test("runProcess waits for all output and decodes split UTF-8", async () => {
  const code = "const s='日本'.repeat(300000); process.stdout.write(s); process.stderr.write('é'.repeat(100001)); process.exit(3)";
  const result = await context.runProcess(process.execPath, ["-e", code]);
  assert.equal(result.code, 3);
  assert.equal(result.stdout, "日本".repeat(300000));
  assert.equal(result.stderr, "é".repeat(100001));
  const bounded = await context.runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], { maxOutputBytes: 1000 });
  assert.equal(bounded.stdout, `${"x".repeat(1000)}\n[output truncated]`);
  const missing = await context.runProcess(path.join(tempDir, "missing.exe"), []);
  assert.equal(missing.code, -1);
  assert.match(missing.stderr, /ENOENT/);
});

test("launchDetached reports missing programs instead of crashing", async () => {
  await assert.rejects(context.launchDetached(path.join(tempDir, "missing app.exe"), ["x"]), /ENOENT/);
});

test("launchDetached passes quoted arguments to .cmd applications", { skip: !windows }, async () => {
  const dir = path.join(tempDir, "batch dir (x)");
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, "out.json");
  const echo = path.join(dir, "echo.cjs");
  await fs.writeFile(echo, `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
  const batch = path.join(dir, "open with & me.cmd");
  await fs.writeFile(batch, `@${cmdQuote(process.execPath)} ${cmdQuote(echo)} %*\r\n`);
  const args = ["C:\\Temp\\a b\\file (1).txt", "it's & fun ^ ok", "50%", "José 日本", "C:\\trailing\\"];
  await context.launchDetached(batch, args, dir);
  const deadline = Date.now() + 15_000;
  while (!existsSync(out) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(JSON.parse(await fs.readFile(out, "utf8")), args);
});

test("Windows Terminal directory argument survives argv parsing", { skip: !windows }, () => {
  const echo = path.join(tempDir, "argv.cjs");
  spawnSync(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(echo)}, "process.stdout.write(JSON.stringify(process.argv.slice(2)))")`]);
  for (const [dir, expected] of [
    ["C:\\", "C:\\"],
    ["C:\\Program Files\\My App", "C:\\Program Files\\My App"],
    ["C:\\semi;colon dir", "C:\\semi\\;colon dir"],
    ["D:\\it's ‘quoted’ & ^ %PATH%", "D:\\it's ‘quoted’ & ^ %PATH%"]
  ]) {
    const argument = context.windowsTerminalDirectoryArguments(dir);
    const result = spawnSync(process.execPath, [`"${echo}"`, argument], {
      argv0: `"${process.execPath}"`,
      windowsVerbatimArguments: true,
      encoding: "utf8"
    });
    assert.deepEqual(JSON.parse(result.stdout), ["-d", expected], argument);
  }
});
