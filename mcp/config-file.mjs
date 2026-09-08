import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";

const TOML = createRequire(import.meta.url)("@iarna/toml");
const editChains = new Map();

export function serializeClientEdit(file, edit) {
  const key = path.resolve(file).toLowerCase();
  const pending = (editChains.get(key) || Promise.resolve()).then(edit, edit);
  editChains.set(key, pending);
  pending.finally(() => { if (editChains.get(key) === pending) editChains.delete(key); }).catch(() => {});
  return pending;
}

export async function writeClientConfigIfUnchanged(file, bytes, expected) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, bytes, { mode: 0o600 });
    const current = await fs.readFile(file).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if ((current === null) !== (expected === null) || (current && !current.equals(expected))) {
      throw Object.assign(new Error("The client configuration changed during setup. Its newer contents were preserved; retry setup."), { code: "CONFIG_CHANGED" });
    }
    if (expected === null) {
      await fs.link(temp, file).catch((error) => {
        if (error.code === "EEXIST") throw Object.assign(new Error("The client configuration was created by another process during setup. Its contents were preserved; retry setup."), { code: "CONFIG_CHANGED" });
        throw error;
      });
    } else {
      await fs.rename(temp, file);
    }
    await fs.chmod(file, 0o600).catch(() => {});
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

function tablePath(header) {
  try {
    let node = TOML.parse(`${header}\n__eb_table_marker = true\n`);
    const parts = [];
    while (node && typeof node === "object" && !node.__eb_table_marker) {
      if (Array.isArray(node)) return null;
      const keys = Object.keys(node);
      if (keys.length !== 1) return null;
      parts.push(keys[0]); node = node[keys[0]];
    }
    return node?.__eb_table_marker ? parts : null;
  } catch {
    return null;
  }
}

function updateStringState(line, initial) {
  let quote = initial;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (quote[0] === '"' && character === "\\") { index += 1; continue; }
      if (line.startsWith(quote, index)) { index += quote.length - 1; quote = ""; }
      continue;
    }
    if (character === "#") break;
    if (character === '"' || character === "'") {
      quote = line.startsWith(character.repeat(3), index) ? character.repeat(3) : character;
      index += quote.length - 1;
    }
  }
  return quote;
}

export function replaceTomlServer(text, name, definition) {
  const before = TOML.parse(text || "");
  if (isDeepStrictEqual(before.mcp_servers?.[name], definition)) return text;
  const sections = [];
  let offset = 0, quote = "", current = null;
  for (const line of text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) || []) {
    if (!line) continue;
    const header = !quote && line.trimStart().startsWith("[") ? tablePath(line.trim()) : null;
    if (header) {
      current = { start: offset, end: offset + line.length, path: header };
      sections.push(current);
    } else if (current && (quote || (line.trim() && !line.trimStart().startsWith("#")))) {
      current.end = offset + line.length;
    }
    quote = updateStringState(line, quote);
    offset += line.length;
  }
  const owned = sections.filter((section) => section.path[0] === "mcp_servers" && section.path[1] === name);
  if (before.mcp_servers?.[name] !== undefined && !owned.length) {
    throw new Error("This client configuration defines the MCP server inline or with dotted assignments. Setup cannot safely preserve that layout; use the displayed configuration snippet to update that entry.");
  }
  let updated = text;
  for (const section of owned.reverse()) updated = updated.slice(0, section.start) + updated.slice(section.end);
  if (definition !== undefined) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const block = TOML.stringify({ mcp_servers: { [name]: definition } }).replace(/\n/g, eol);
    updated += `${updated && !/[\r\n]$/.test(updated) ? eol : ""}${updated ? eol : ""}${block}`;
  }
  let after;
  try { after = TOML.parse(updated); } catch {
    throw new Error("Setup cannot safely add an MCP table to this client configuration layout. Its contents were preserved; use the displayed configuration snippet.");
  }
  if (!isDeepStrictEqual(after.mcp_servers?.[name], definition)) throw new Error("The MCP configuration edit did not produce the expected server definition.");
  for (const document of [before, after]) {
    if (document.mcp_servers) {
      delete document.mcp_servers[name];
      if (!Object.keys(document.mcp_servers).length) delete document.mcp_servers;
    }
  }
  if (!isDeepStrictEqual(before, after)) throw new Error("The MCP configuration edit would change unrelated settings; the original configuration was preserved.");
  return updated;
}
