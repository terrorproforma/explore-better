// Registry helpers for the current-user Explorer integration: locale-independent
// reg.exe parsing, .reg file encoding, shell backup policy, and UTF-8 child
// process output. Kept free of server state so they can be unit tested.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { powerShellLiteral } from "./shell-quote.mjs";

export { powerShellLiteral };

export const exploreBetterShellVerb = "ExploreBetter";

// reg.exe prints value lines as "    <name>    <REG_TYPE>    <data>". The name
// column of the default value is localized ("(Default)", "(Standard)",
// "(par défaut)"...), so values are located by position instead of by label.
const regValueLinePattern = /^\s+(.*?)\s{4}(REG_[A-Z0-9_]+)(?:\s{4}(.*))?$/;

export function parseRegQueryValueLines(stdout) {
  const values = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = line.match(regValueLinePattern);
    if (match) {
      values.push({ name: match[1], type: match[2], data: match[3] ?? "" });
    }
  }
  return values;
}

// The first value line of `reg query <key> /ve` (or `/v <name>`), whatever its label.
export function parseRegQueryValue(stdout, name = null) {
  const values = parseRegQueryValueLines(stdout);
  if (name) {
    const wanted = String(name).toLowerCase();
    return values.find((value) => value.name.toLowerCase() === wanted) || values[0] || null;
  }
  return values[0] || null;
}

// A default that is not set is still printed by `/ve`, with a localized
// "(value not set)" placeholder as its data. Real data is rarely wrapped in
// parentheses, so only those need a second look.
export function regDataMayBeNotSetPlaceholder(data) {
  return /^\(.*\)$/.test(String(data || "").trim());
}

// Resolves a reg.exe value query. For the default value, `listingStdout` (the
// output of `reg query <key>` without /ve) decides whether a parenthesized
// placeholder is real: an unset default is omitted from the full listing.
export function resolveRegistryValue(queryStdout, name = null, listingStdout = null) {
  const parsed = parseRegQueryValue(queryStdout, name);
  if (!parsed) {
    return { valueExists: false, type: null, value: null };
  }
  const value = String(parsed.data || "").trim();
  if (!name && regDataMayBeNotSetPlaceholder(value)) {
    const label = parsed.name.toLowerCase();
    const listed =
      listingStdout != null
        ? parseRegQueryValueLines(listingStdout).some((item) => item.name.toLowerCase() === label)
        : !/^\(value not set\)$/i.test(value);
    if (!listed) {
      return { valueExists: false, type: parsed.type, value: null };
    }
  }
  return { valueExists: true, type: parsed.type, value };
}

// reg import reads "Windows Registry Editor Version 5.00" files as UTF-16LE when
// they start with a BOM and as ANSI otherwise, so non-ASCII paths need UTF-16LE.
// Line endings are normalized to CRLF as regedit writes them.
export function registryFileBuffer(content) {
  return Buffer.from(`\ufeff${String(content ?? "").replace(/\r?\n/g, "\r\n")}`, "utf16le");
}

// Windows PowerShell 5.1 reads BOM-less .ps1 files as ANSI.
export function powerShellScriptBuffer(content) {
  return Buffer.from(`\ufeff${String(content ?? "")}`, "utf8");
}

export function isExploreBetterShellDefault(value) {
  return String(value ?? "").trim().toLowerCase() === exploreBetterShellVerb.toLowerCase();
}

const shellDefaultEntryIds = new Set(["directoryShell", "driveShell"]);

export function shellDefaultEntryIdList() {
  return [...shellDefaultEntryIds];
}

// True when the snapshot recorded Explore Better itself as a folder/drive default,
// which must never be treated as the "original" shell state.
export function shellBackupHasExploreBetterDefault(backup) {
  return (backup?.entries || []).some((entry) => {
    if (!shellDefaultEntryIds.has(entry?.id)) return false;
    const value = entry.values?.default;
    return Boolean(value?.valueExists) && isExploreBetterShellDefault(value.value);
  });
}

export function hasUnrestoredShellBackup(backup) {
  return Boolean(backup?.entries?.length) && !backup.restoredAt;
}

// Decides what to do with a freshly captured snapshot:
// - keep-original: an unrestored original backup exists; never overwrite it.
// - refuse-original: Explore Better already owns the default, so the snapshot
//   would make a restore re-apply Explore Better.
// - replace: the snapshot becomes the new original backup.
export function planShellBackupSave({ existing, snapshot }) {
  if (hasUnrestoredShellBackup(existing)) {
    return {
      action: "keep-original",
      reason: "An unrestored original shell backup already exists and was kept."
    };
  }
  if (shellBackupHasExploreBetterDefault(snapshot)) {
    return {
      action: "refuse-original",
      reason:
        "Explore Better is currently the folder or drive default, so this snapshot cannot be stored as the original shell backup."
    };
  }
  return { action: "replace", reason: "" };
}

// .reg content that resets only the folder/drive defaults back to Explorer.
export function folderDefaultResetRegistryContent() {
  return [
    "Windows Registry Editor Version 5.00",
    "",
    "[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell]",
    "@=-",
    "",
    "[HKEY_CURRENT_USER\\Software\\Classes\\Drive\\shell]",
    "@=-",
    ""
  ].join("\r\n");
}

// PowerShell that repairs a target passed by Explorer for a drive root. Windows
// expands "%1" to "C:\" and argv parsing turns the trailing \" into a quote.
export const launcherTargetNormalizationPs = `if ($TargetPath) {
  $TargetPath = $TargetPath.Trim().TrimEnd([char]34)
  if ($TargetPath -match '^[A-Za-z]:$') {
    $TargetPath = $TargetPath + [IO.Path]::DirectorySeparatorChar
  }
}`;

// Reads HKCU values through .NET so data is never lost to the OEM code page and
// the default value is addressed by its empty name rather than a localized label.
export function registrySnapshotScript(requests) {
  const rows = requests.map(({ key, name }) => {
    const subKey = String(key).replace(/^(HKCU|HKEY_CURRENT_USER)\\/i, "");
    if (subKey === String(key)) {
      throw new Error(`Only HKCU registry keys can be snapshotted: ${key}`);
    }
    return `  ,@(${powerShellLiteral(subKey)}, ${powerShellLiteral(name || "")})`;
  });
  return `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$requests = @(
${rows.join("\n")}
)
$kinds = @{ String = 'REG_SZ'; ExpandString = 'REG_EXPAND_SZ'; MultiString = 'REG_MULTI_SZ'; DWord = 'REG_DWORD'; QWord = 'REG_QWORD'; Binary = 'REG_BINARY'; None = 'REG_NONE' }
$results = @(foreach ($request in $requests) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($request[0], $false)
  if ($null -eq $key) {
    [ordered]@{ keyExists = $false; valueExists = $false; type = $null; value = $null }
    continue
  }
  try {
    $name = $request[1]
    if (@($key.GetValueNames()) -notcontains $name) {
      [ordered]@{ keyExists = $true; valueExists = $false; type = $null; value = $null }
      continue
    }
    $kind = $key.GetValueKind($name).ToString()
    $raw = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $text = if ($raw -is [string]) { $raw } elseif ($raw -is [string[]]) { $raw -join [char]0 } else { [string]$raw }
    $type = if ($kinds.ContainsKey($kind)) { $kinds[$kind] } else { 'REG_' + $kind.ToUpperInvariant() }
    [ordered]@{ keyExists = $true; valueExists = $true; type = $type; value = $text }
  } finally {
    $key.Close()
  }
})
ConvertTo-Json -Compress -Depth 3 -InputObject $results
`;
}

export function parseRegistrySnapshotOutput(stdout, expectedCount) {
  const text = String(stdout || "").replace(/^\ufeff/, "").trim();
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length !== expectedCount) {
    throw new Error(`Registry snapshot returned ${rows.length} of ${expectedCount} values.`);
  }
  return rows.map((row) => ({
    keyExists: row?.keyExists === true,
    valueExists: row?.valueExists === true,
    type: typeof row?.type === "string" ? row.type : null,
    value: row?.valueExists === true && row.value != null ? String(row.value) : null
  }));
}

export function encodedPowerShellCommand(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}

// A -Command wrapper around a generated script: forces UTF-8 output and keeps
// the -File exit-code contract (1 on an uncaught error, else the script's code).
// Switch arguments such as -Desktop pass through; everything else is a literal.
export function integrationScriptCommand(scriptPath, args = []) {
  const argumentText = args
    .map((arg) => (/^-[A-Za-z]\w*$/.test(String(arg)) ? String(arg) : powerShellLiteral(arg)))
    .join(" ");
  return `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$global:LASTEXITCODE = 0
try {
  & ${powerShellLiteral(scriptPath)}${argumentText ? ` ${argumentText}` : ""}
} catch {
  [Console]::Error.WriteLine(($_ | Out-String))
  exit 1
}
if ($LASTEXITCODE) { exit $LASTEXITCODE }
exit 0
`;
}

export function powerShellEncodedArgs(script) {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedPowerShellCommand(script)];
}

// spawn() wrapper that decodes stdout/stderr as UTF-8 once the streams close, so
// multi-byte characters split across chunks are never mangled.
export function runProcessUtf8(file, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: error.message });
      return;
    }
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timeout = null;
    const text = (chunks) => Buffer.concat(chunks).toString("utf8").replace(/^\ufeff/, "");
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    const timeoutMs = Number(options.timeoutMs || 0);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeout = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish({ code: -1, stdout: text(stdout), stderr: text(stderr), timedOut: true });
      }, timeoutMs);
      timeout.unref?.();
    }
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish({ code: -1, stdout: text(stdout), stderr: error.message }));
    child.on("close", (code) => finish({ code, stdout: text(stdout), stderr: text(stderr) }));
  });
}

// Swaps a freshly staged install into place without ever deleting the live copy
// first: live -> <root>.old-<ts>, staging -> live, then best-effort removal of the
// old copy. A locked executable makes the first rename fail and leaves the
// current install untouched.
export async function swapInstalledDirectory(installedRoot, stagingRoot, { rename = fs.rename, now = Date.now() } = {}) {
  const oldRoot = `${installedRoot}.old-${now}`;
  let movedOld = false;
  try {
    await fs.access(installedRoot);
    await rename(installedRoot, oldRoot);
    movedOld = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      const wrapped = new Error(
        `The installed Explore Better app is in use (${error.code || error.message}). Close it and try again.`
      );
      wrapped.cause = error;
      throw wrapped;
    }
  }
  try {
    await rename(stagingRoot, installedRoot);
  } catch (error) {
    if (movedOld) {
      await rename(oldRoot, installedRoot).catch(() => {});
    }
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const oldRemoved = movedOld ? await fs.rm(oldRoot, { recursive: true, force: true }).then(() => true, () => false) : true;
  return { oldRoot: movedOld ? oldRoot : null, oldRemoved };
}

// Removes leftovers of earlier swaps (<root>.old-* and <root>.staging-*).
export async function cleanStaleInstallDirectories(installedRoot) {
  const parent = path.dirname(installedRoot);
  const base = path.basename(installedRoot).toLowerCase();
  let names = [];
  try {
    names = await fs.readdir(parent);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (!lower.startsWith(`${base}.old-`) && !lower.startsWith(`${base}.staging-`)) continue;
    const target = path.join(parent, name);
    const ok = await fs.rm(target, { recursive: true, force: true }).then(() => true, () => false);
    if (ok) removed.push(target);
  }
  return removed;
}
