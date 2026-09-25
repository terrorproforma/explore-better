// Unit tests for the Explorer-integration registry helpers. Nothing here writes
// to the registry: parsing uses captured reg.exe output and the only live
// registry access is a read-only .NET snapshot of HKCU.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanStaleInstallDirectories,
  folderDefaultResetRegistryContent,
  integrationScriptCommand,
  launcherTargetNormalizationPs,
  parseRegQueryValue,
  parseRegistrySnapshotOutput,
  planShellBackupSave,
  powerShellEncodedArgs,
  powerShellLiteral,
  powerShellScriptBuffer,
  registryFileBuffer,
  registrySnapshotScript,
  resolveRegistryValue,
  runProcessUtf8,
  shellBackupHasExploreBetterDefault,
  swapInstalledDirectory
} from "../lib/shell-registry.mjs";

const windows = process.platform === "win32";
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "eb-shell-registry-"));
test.after(() => rm(fixtureRoot, { recursive: true, force: true }));

const key = "HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell";
const regOutput = (...valueLines) => ["", key, ...valueLines, "", ""].join("\r\n");

test("reads the default value from English reg.exe output", () => {
  const stdout = regOutput("    (Default)    REG_SZ    ExploreBetter");
  assert.deepEqual(resolveRegistryValue(stdout), { valueExists: true, type: "REG_SZ", value: "ExploreBetter" });
});

test("reads the default value from German reg.exe output", () => {
  const stdout = regOutput("    (Standard)    REG_SZ    ExploreBetter");
  assert.deepEqual(resolveRegistryValue(stdout), { valueExists: true, type: "REG_SZ", value: "ExploreBetter" });
});

test("reads the default value when the OEM label is garbled (French)", () => {
  const stdout = regOutput("    (par d\ufffdfaut)    REG_SZ    none");
  assert.equal(resolveRegistryValue(stdout).value, "none");
});

test("keeps data that contains runs of spaces", () => {
  const command = 'powershell.exe -NoProfile    -File "C:\\Some  Dir\\open.ps1" "%1"';
  const stdout = regOutput(`    (Default)    REG_SZ    ${command}`);
  assert.equal(resolveRegistryValue(stdout).value, command);
});

test("treats an unset English default as absent", () => {
  const query = regOutput("    (Default)    REG_SZ    (value not set)");
  const listing = regOutput("    Other    REG_SZ    x");
  assert.equal(resolveRegistryValue(query, null, listing).valueExists, false);
  assert.equal(resolveRegistryValue(query).valueExists, false, "English placeholder recognized without a listing");
});

test("treats an unset German default as absent using the full key listing", () => {
  const query = regOutput("    (Standard)    REG_SZ    (Wert nicht festgelegt)");
  const listing = ["", key, "    Other    REG_SZ    x", "", `${key}\\ExploreBetter`, ""].join("\r\n");
  assert.deepEqual(resolveRegistryValue(query, null, listing), { valueExists: false, type: "REG_SZ", value: null });
});

test("keeps a parenthesized default that the listing shows is really set", () => {
  const query = regOutput("    (Standard)    REG_SZ    (custom)");
  const listing = regOutput("    (Standard)    REG_SZ    (custom)");
  assert.deepEqual(resolveRegistryValue(query, null, listing), { valueExists: true, type: "REG_SZ", value: "(custom)" });
});

test("an empty default string is a set value", () => {
  assert.deepEqual(resolveRegistryValue(regOutput("    (Default)    REG_SZ    ")), {
    valueExists: true,
    type: "REG_SZ",
    value: ""
  });
  assert.equal(resolveRegistryValue(regOutput("    (Standard)    REG_SZ")).valueExists, true);
});

test("reads named values and reports missing output", () => {
  const stdout = regOutput("    Icon    REG_SZ    C:\\App\\Explore Better.exe");
  assert.equal(parseRegQueryValue(stdout, "icon").data, "C:\\App\\Explore Better.exe");
  assert.equal(resolveRegistryValue(stdout, "Icon").value, "C:\\App\\Explore Better.exe");
  assert.deepEqual(resolveRegistryValue(regOutput()), { valueExists: false, type: null, value: null });
});

test(".reg files are UTF-16LE with a BOM and CRLF line endings", () => {
  const content = 'Windows Registry Editor Version 5.00\n\n[HKEY_CURRENT_USER\\x]\n@="C:\\\\Users\\\\Zoë\\\\App.exe"\n';
  const bytes = registryFileBuffer(content);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  const decoded = bytes.subarray(2).toString("utf16le");
  assert.equal(decoded, content.replace(/\n/g, "\r\n"));
  assert.ok(decoded.includes("Zoë"));
  assert.deepEqual([...registryFileBuffer(folderDefaultResetRegistryContent()).subarray(0, 2)], [0xff, 0xfe]);
});

test("PowerShell scripts are written as UTF-8 with a BOM", () => {
  const bytes = powerShellScriptBuffer("$x = 'Zoë'");
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.subarray(3).toString("utf8"), "$x = 'Zoë'");
});

function backupWith(directoryDefault, { restoredAt = null } = {}) {
  const value = (text) =>
    text == null
      ? { keyExists: true, valueExists: false, type: null, value: null }
      : { keyExists: true, valueExists: true, type: "REG_SZ", value: text };
  return {
    id: "b",
    restoredAt,
    entries: [
      { id: "directoryShell", kind: "defaultOnly", keyExists: true, values: { default: value(directoryDefault) } },
      { id: "driveShell", kind: "defaultOnly", keyExists: true, values: { default: value(null) } },
      { id: "directoryExploreBetter", kind: "ownedKey", keyExists: false, values: {} }
    ]
  };
}

test("an unrestored original backup is never replaced", () => {
  const existing = backupWith(null);
  assert.equal(planShellBackupSave({ existing, snapshot: backupWith(null) }).action, "keep-original");
  assert.equal(planShellBackupSave({ existing, snapshot: backupWith("ExploreBetter") }).action, "keep-original");
});

test("a snapshot taken while Explore Better is the default is refused as an original", () => {
  assert.equal(shellBackupHasExploreBetterDefault(backupWith("ExploreBetter")), true);
  assert.equal(shellBackupHasExploreBetterDefault(backupWith("exploreBETTER")), true);
  assert.equal(shellBackupHasExploreBetterDefault(backupWith("none")), false);
  assert.equal(shellBackupHasExploreBetterDefault(backupWith(null)), false);
  assert.equal(planShellBackupSave({ existing: null, snapshot: backupWith("ExploreBetter") }).action, "refuse-original");
  const restored = backupWith(null, { restoredAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(planShellBackupSave({ existing: restored, snapshot: backupWith("ExploreBetter") }).action, "refuse-original");
});

test("a clean snapshot replaces a missing or restored backup", () => {
  assert.equal(planShellBackupSave({ existing: null, snapshot: backupWith("none") }).action, "replace");
  const restored = backupWith(null, { restoredAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(planShellBackupSave({ existing: restored, snapshot: backupWith(null) }).action, "replace");
});

test("snapshot script rejects non-HKCU keys and output parsing validates counts", () => {
  assert.throws(() => registrySnapshotScript([{ key: "HKLM\\Software", name: null }]));
  const rows = parseRegistrySnapshotOutput('\ufeff[{"keyExists":true,"valueExists":true,"type":"REG_SZ","value":"Zoë"}]', 1);
  assert.deepEqual(rows, [{ keyExists: true, valueExists: true, type: "REG_SZ", value: "Zoë" }]);
  assert.throws(() => parseRegistrySnapshotOutput("[]", 1));
});

test("swaps a staged install in and removes the old copy", async () => {
  const root = path.join(fixtureRoot, "swap", "App");
  const staging = `${root}.staging-1`;
  await mkdir(root, { recursive: true });
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(root, "version.txt"), "old");
  await writeFile(path.join(staging, "version.txt"), "new");
  const result = await swapInstalledDirectory(root, staging, { now: 42 });
  assert.equal(await readFile(path.join(root, "version.txt"), "utf8"), "new");
  assert.equal(existsSync(staging), false);
  assert.equal(result.oldRemoved, true);
  assert.equal(existsSync(`${root}.old-42`), false);
});

test("a locked install is left intact when it cannot be moved aside", async () => {
  const root = path.join(fixtureRoot, "locked", "App");
  const staging = `${root}.staging-1`;
  await mkdir(root, { recursive: true });
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(root, "version.txt"), "old");
  const rename = async () => {
    const error = new Error("resource busy");
    error.code = "EBUSY";
    throw error;
  };
  await assert.rejects(swapInstalledDirectory(root, staging, { rename }), /in use/);
  assert.equal(await readFile(path.join(root, "version.txt"), "utf8"), "old");
  assert.equal(existsSync(staging), false);
});

test("cleans stale .old and .staging directories only", async () => {
  const parent = path.join(fixtureRoot, "stale");
  const root = path.join(parent, "App");
  for (const name of ["App", "App.old-1", "App.staging-2", "Apple", "Integration"]) {
    await mkdir(path.join(parent, name), { recursive: true });
  }
  const removed = await cleanStaleInstallDirectories(root);
  assert.equal(removed.length, 2);
  assert.deepEqual((await readdir(parent)).sort(), ["App", "Apple", "Integration"]);
});

function runPowerShellScript(script) {
  return runProcessUtf8("powershell.exe", powerShellEncodedArgs(script), { timeoutMs: 60000 });
}

const literalSamples = [
  "C:\\Program Files\\Explore Better\\Explore Better.exe",
  "C:\\Users\\A$b\\$env:TEMP\\x",
  "C:\\Users\\back`tick\\`$x",
  "C:\\Users\\O'Brien\\O\u2019Neil\\\u2018q\u201b",
  "\\\\server\\share\\dir",
  "C:\\Users\\Zoë Ünïcødé\\桌面",
  "D:\\trailing\\"
];

test("PowerShell literals round-trip through Write-Output", { skip: !windows }, async () => {
  const script = [
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    ...literalSamples.map((sample) => `Write-Output ${powerShellLiteral(sample)}`)
  ].join("\n");
  const result = await runPowerShellScript(script);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout.replace(/\r?\n$/, "").split(/\r?\n/), literalSamples);
});

test("literals in a BOM .ps1 file survive Windows PowerShell file decoding", { skip: !windows }, async () => {
  const scriptPath = path.join(fixtureRoot, "Zoë $dir", "literals.ps1");
  await mkdir(path.dirname(scriptPath), { recursive: true });
  const content = literalSamples.map((sample) => `Write-Output ${powerShellLiteral(sample)}`).join("\n");
  await writeFile(scriptPath, powerShellScriptBuffer(content));
  const result = await runPowerShellScript(integrationScriptCommand(scriptPath));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout.replace(/\r?\n$/, "").split(/\r?\n/), literalSamples);
});

test("integration script command keeps exit codes, switches and literal arguments", { skip: !windows }, async () => {
  const scriptPath = path.join(fixtureRoot, "args $x", "args.ps1");
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(
    scriptPath,
    powerShellScriptBuffer(
      'param([string]$Target, [switch]$Desktop)\n$ErrorActionPreference = "Stop"\nWrite-Output "target=$Target desktop=$Desktop"\nif ($Target -eq "fail") { throw "boom from script" }\nif ($Target -eq "code") { exit 3 }\n'
    )
  );
  const target = "C:\\Users\\O\u2019Neil\\$HOME\\Zoë";
  const ok = await runPowerShellScript(integrationScriptCommand(scriptPath, [target, "-Desktop"]));
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), `target=${target} desktop=True`);
  const failed = await runPowerShellScript(integrationScriptCommand(scriptPath, ["fail"]));
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /boom from script/);
  const coded = await runPowerShellScript(integrationScriptCommand(scriptPath, ["code"]));
  assert.equal(coded.code, 3);
});

function runVerbatim(commandLine) {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", [commandLine], { windowsHide: true, windowsVerbatimArguments: true });
    const out = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => out.push(chunk));
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8") }));
  });
}

test("launcher normalizes the drive-root target Explorer passes", { skip: !windows }, async () => {
  const scriptPath = path.join(fixtureRoot, "launcher-target.ps1");
  await writeFile(
    scriptPath,
    powerShellScriptBuffer(`param([string]$TargetPath = $PWD.Path)\n${launcherTargetNormalizationPs}\nWrite-Output "[$TargetPath]"\n`)
  );
  const cases = [
    ['"C:\\"', "[C:\\]"],
    ['"D:"', "[D:\\]"],
    ['"C:\\Some Dir"', "[C:\\Some Dir]"],
    ['"\\\\server\\share\\dir"', "[\\\\server\\share\\dir]"]
  ];
  for (const [argument, expected] of cases) {
    const result = await runVerbatim(`-NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" ${argument}`);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.stdout.trim(), expected, `argument ${argument}`);
  }
});

test("read-only HKCU snapshot addresses the default value by empty name", { skip: !windows }, async () => {
  const requests = [
    { key: "HKCU\\Software", name: null },
    { key: "HKCU\\Control Panel\\Desktop", name: "CaretWidth" },
    { key: "HKCU\\Software\\ExploreBetterRegistryTestMissing\\*\\shell", name: null },
    { key: "HKCU\\Control Panel\\Desktop", name: "ExploreBetterRegistryTestMissingValue" }
  ];
  const result = await runPowerShellScript(registrySnapshotScript(requests));
  assert.equal(result.code, 0, result.stderr);
  const [software, caret, missingKey, missingValue] = parseRegistrySnapshotOutput(result.stdout, requests.length);
  assert.equal(software.keyExists, true);
  assert.equal(typeof software.valueExists, "boolean");
  if (caret.valueExists) {
    assert.equal(caret.type, "REG_DWORD");
  }
  assert.deepEqual(missingKey, { keyExists: false, valueExists: false, type: null, value: null });
  assert.deepEqual(missingValue, { keyExists: true, valueExists: false, type: null, value: null });
});
