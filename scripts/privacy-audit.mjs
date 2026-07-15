import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024
}).split("\0").filter(Boolean);

const forbiddenPaths = [
  { name: "environment file", pattern: /(^|\/)\.env(?:\.|$)/i },
  { name: "private signing material", pattern: /\.(?:pfx|p12|jks|keystore|key)$/i }
];

const contentRules = [
  {
    name: "absolute Windows user-profile path",
    pattern: /\b[A-Za-z]:\\Users\\(?!Public(?:\\|$)|Default(?: User)?(?:\\|$)|All Users(?:\\|$)|<)[^\\\r\n]+\\/gi
  },
  {
    name: "personal email address",
    pattern: /\b[A-Z0-9._%+-]+@(?:gmail|hotmail|outlook|yahoo|icloud|protonmail|proton)\.[A-Z]{2,}\b/gi
  },
  {
    name: "street address",
    pattern: /\b\d{1,6}\s+[A-Z0-9.' -]{2,48}\s(?:Avenue|Ave|Boulevard|Blvd|Court|Ct|Drive|Dr|Highway|Hwy|Lane|Ln|Road|Rd|Street|St)\b/gi
  },
  {
    name: "identity-verification URL",
    pattern: /https?:\/\/(?:credentials\.microsoft\.com\/verify|[^\s/]*au10tixservices\.com)\S*/gi
  },
  {
    name: "Azure subscription resource ID",
    pattern: /\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/|\b)/gi
  },
  {
    name: "identity-validation identifier",
    pattern: /identity[ -]?validation(?:\s+request)?(?:\s+(?:id|identifier))?[^\r\n]{0,80}\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
  },
  {
    name: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g
  },
  {
    name: "GitHub access token",
    pattern: /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b/g
  },
  {
    name: "AWS access key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g
  }
];

const findings = [];

for (const file of trackedFiles) {
  for (const rule of forbiddenPaths) {
    if (rule.pattern.test(file)) findings.push({ file, line: 1, rule: rule.name });
  }

  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    continue;
  }
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const rule of contentRules) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      findings.push({ file, line, rule: rule.name });
    }
  }
}

if (findings.length) {
  console.error("Privacy audit failed. Potential private data was found:");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} (${finding.rule})`);
  }
  console.error("Matches are intentionally omitted from output.");
  process.exit(1);
}

console.log(`Privacy audit passed (${trackedFiles.length} tracked files checked).`);
