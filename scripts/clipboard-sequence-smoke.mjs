import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { promisify } from "node:util";

// Exercise the production PowerShell transaction against a fake Win32 API.
// The user's clipboard is never opened, read, written or cleared by this test.
const run = path.join(process.cwd(), "artifacts", `clipboard-sequence-${Date.now()}`);
await fs.mkdir(run, { recursive: true });
const source = await fs.readFile("server.mjs", "utf8");
const functionSource = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const fakeNative = `Add-Type -TypeDefinition @'
using System;
public static class EBClipboard {
  private static bool opened;
  private static uint sequence = 42;
  public static uint GetClipboardSequenceNumber() { if (!opened) throw new Exception("Sequence checked without clipboard lock"); return sequence; }
  public static bool OpenClipboard(IntPtr owner) { opened = true; return true; }
  public static bool EmptyClipboard() { if (!opened) throw new Exception("Cleared without clipboard lock"); sequence++; return true; }
  public static bool CloseClipboard() { opened = false; return true; }
}
'@`;
let executions = 0;
const context = vm.createContext({
  parsePowerShellJson: result => JSON.parse(result.stdout.trim()),
  runPowerShellPayload: async (script, payload) => {
    executions++;
    const scriptPath = path.join(run, `case-${executions}.ps1`), payloadPath = path.join(run, `case-${executions}.json`);
    const safeScript = script.replace(context.clipboardNativePowerShell(), fakeNative);
    assert.ok(!safeScript.includes("DllImport"));
    await fs.writeFile(scriptPath, safeScript);
    await fs.writeFile(payloadPath, JSON.stringify(payload));
    return promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-PayloadPath", payloadPath], { windowsHide: true, timeout: 20_000 });
  }
});
vm.runInContext(functionSource("function clipboardNativePowerShell()", "async function writeClipboardFiles(") + functionSource("async function clearClipboardFiles(", "function findInstalledAppBrowser("), context);
const checks = [];
for (const [id, input, expected] of [
  ["matching-sequence-clears-under-lock", { expectedSequence: 42 }, { cleared: true, sequence: 43 }],
  ["newer-clipboard-is-preserved", { expectedSequence: 41 }, { cleared: false, sequence: 42 }],
  ["explicit-clear-is-supported", {}, { cleared: true, sequence: 43 }]
]) {
  const result = await context.clearClipboardFiles(input);
  assert.deepEqual(result, expected, id); checks.push({ id, ok: true });
}
for (const value of [null, -1, 1.5, 0x100000000, "42"]) await assert.rejects(context.clearClipboardFiles({ expectedSequence: value }), /Invalid clipboard sequence/);
assert.equal(executions, 3);
checks.push({ id: "invalid-sequences-rejected-before-native-call", ok: true });
await fs.writeFile("artifacts/clipboard-sequence-latest.json", JSON.stringify({ checks, run }, null, 2));
console.log(`Clipboard sequence: ${checks.length} pass, 0 fail`);
