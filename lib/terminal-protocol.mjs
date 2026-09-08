import path from "node:path";
import { fileURLToPath } from "node:url";

export function terminalMarkerDirectory(value, isFileUrl = false) {
  const raw = String(value || "");
  if (!raw || /[\0\r\n]/.test(raw)) return "";
  if (isFileUrl) {
    try {
      const url = new URL(raw);
      return url.protocol === "file:" ? fileURLToPath(url) : "";
    } catch {
      return "";
    }
  }
  // OSC 9;9 carries a literal shell path, whereas OSC 7 carries a file URL.
  return raw.replace(/^\/+([A-Za-z]:)/, "$1").replaceAll("/", path.sep);
}

export function quoteWindowsArgument(value) {
  // CommandLineToArgvW/CRT quoting: double slashes before quotes and the closing quote.
  const argument = String(value);
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export function windowsArgumentList(args) {
  return args.map(quoteWindowsArgument).join(" ");
}
