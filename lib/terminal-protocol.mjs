import path from "node:path";
import { fileURLToPath } from "node:url";

// Lower-cased \\server\share root of a UNC path; device paths (\\?\, \\.\) and
// non-UNC paths yield "".
export function uncRoot(value) {
  const normalized = path.win32.normalize(String(value || ""));
  const match = /^\\\\([^\\?.][^\\]*)\\([^\\]+)/.exec(normalized);
  return match ? `\\\\${match[1]}\\${match[2]}`.toLowerCase() : "";
}

function acceptedMarkerDirectory(directory, allowedUncRoots) {
  if (process.platform !== "win32") return path.isAbsolute(directory) ? directory : "";
  if (/^[A-Za-z]:\\/.test(directory)) return directory;
  // Any program's output can carry these markers, so a remote share is only
  // trusted when this session itself was started in or synced to it.
  const root = uncRoot(directory);
  return root && allowedUncRoots?.has?.(root) ? path.win32.normalize(directory) : "";
}

export function terminalMarkerDirectory(value, isFileUrl = false, allowedUncRoots = null) {
  const raw = String(value || "");
  if (!raw || /[\0\r\n]/.test(raw)) return "";
  let directory;
  if (isFileUrl) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "file:") return "";
      directory = fileURLToPath(url);
    } catch {
      return "";
    }
  } else {
    // OSC 9;9 carries a literal shell path, whereas OSC 7 carries a file URL.
    directory = raw.replace(/^\/+([A-Za-z]:)/, "$1").replaceAll("/", path.sep);
  }
  return acceptedMarkerDirectory(directory, allowedUncRoots);
}

export function quoteWindowsArgument(value) {
  // CommandLineToArgvW/CRT quoting: double slashes before quotes and the closing quote.
  const argument = String(value);
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export function windowsArgumentList(args) {
  return args.map(quoteWindowsArgument).join(" ");
}
