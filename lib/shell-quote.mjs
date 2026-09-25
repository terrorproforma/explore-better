// Quoting helpers shared by the backend, terminal service, and renderer.
// PowerShell treats U+2018..U+201B as single-quote characters, so every one of
// them (not only the ASCII apostrophe) must be doubled inside a literal.
const powerShellQuoteCharacters = /['‘-‛]/g;

export function powerShellLiteral(value) {
  return `'${String(value ?? "").replace(powerShellQuoteCharacters, "$&$&")}'`;
}

// Argument for a cmd.exe command line (cmd /c or a line typed at a prompt).
// Windows paths cannot contain double quotes, but % must never be expanded, so
// each % is emitted as an unquoted ^%. Trailing backslashes are kept outside the
// quotes so C-runtime argument parsers never read \" as an escaped quote.
// Callers spawning cmd.exe must pass windowsVerbatimArguments.
export function cmdQuote(value) {
  return String(value ?? "")
    .split("%")
    .map((part) => {
      const text = part.replaceAll('"', '""');
      const body = text.replace(/\\+$/, "");
      return `"${body}"${text.slice(body.length)}`;
    })
    .join("^%");
}
