import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("Operation aborted", "AbortError");
}

export function sameFileIdentity(left, right) {
  return Boolean(left && right && String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino));
}

export async function pathSnapshot(target, { signal } = {}) {
  const content = crypto.createHash("sha256");
  const state = crypto.createHash("sha256");
  let rootIdentity;
  let entries = 0;
  async function visit(itemPath, relative) {
    throwIfAborted(signal);
    const before = await fs.lstat(itemPath);
    const identity = { dev: String(before.dev), ino: String(before.ino) };
    if (!relative) rootIdentity = identity;
    let kind;
    let value = "";
    if (before.isSymbolicLink()) {
      kind = "link";
      value = await fs.readlink(itemPath);
    } else if (before.isDirectory()) {
      kind = "directory";
    } else if (before.isFile()) {
      kind = "file";
      const hash = crypto.createHash("sha256");
      for await (const chunk of createReadStream(itemPath, { signal })) hash.update(chunk);
      value = hash.digest("hex");
    } else {
      throw new Error(`Unsupported file type in transaction: ${itemPath}`);
    }
    const after = await fs.lstat(itemPath);
    if (!sameFileIdentity(identity, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`File changed while verifying transaction: ${itemPath}`);
    }
    entries += 1;
    content.update(JSON.stringify([relative, kind, value]) + "\n");
    state.update(JSON.stringify([relative, kind, identity, before.mode, before.size, before.mtimeMs, value]) + "\n");
    if (kind === "directory") {
      const names = await fs.readdir(itemPath);
      names.sort();
      for (const name of names) await visit(path.join(itemPath, name), relative ? `${relative}/${name}` : name);
    }
  }
  await visit(path.resolve(target), "");
  throwIfAborted(signal);
  return { version: 1, identity: rootIdentity, entries, contentDigest: content.digest("hex"), stateDigest: state.digest("hex") };
}

export function validSnapshot(value) {
  return Boolean(value?.version === 1 && /^[a-f0-9]{64}$/.test(value.contentDigest) && /^[a-f0-9]{64}$/.test(value.stateDigest));
}

export function decodeEditableText(buffer) {
  let encoding = "utf8";
  let bom = false;
  let bytes = buffer;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = "utf16le";
    bom = true;
    bytes = buffer.subarray(2);
  } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = "utf16be";
    bom = true;
    bytes = buffer.subarray(2);
  } else if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    bom = true;
    bytes = buffer.subarray(3);
  }
  try {
    const content = new TextDecoder(encoding === "utf8" ? "utf-8" : encoding === "utf16le" ? "utf-16le" : "utf-16be", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (encoding === "utf8" && content.includes("\0")) throw new Error("Binary text");
    return { content, encoding, bom };
  } catch {
    throw new Error("This file uses an unsupported or invalid text encoding. Open it in an external editor to preserve its bytes.");
  }
}

export function encodeEditableText(content, { encoding = "utf8", bom = false } = {}) {
  let bytes = Buffer.from(String(content), encoding === "utf8" ? "utf8" : "utf16le");
  if (encoding === "utf16be") bytes = bytes.swap16();
  return bom ? Buffer.concat([Buffer.from(encoding === "utf8" ? [0xef, 0xbb, 0xbf] : encoding === "utf16le" ? [0xff, 0xfe] : [0xfe, 0xff]), bytes]) : bytes;
}

export async function physicalPath(target) {
  let current = path.resolve(target);
  const missing = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missing.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function insidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function assertSafeDestination(source, destination) {
  const [src, dest, stat] = await Promise.all([physicalPath(source), physicalPath(destination), fs.lstat(source)]);
  if (path.relative(src, dest) === "" || (stat.isDirectory() && insidePath(dest, src))) {
    throw new Error("The destination resolves to the source or one of its descendants.");
  }
}

export async function durableWrite(file, bytes, mode = 0o600) {
  const handle = await fs.open(file, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Preserve the old file before atomically replacing its name. A failed writer or
// commit leaves the original in place; the durable backup is also the undo data.
export async function replaceFileTransaction(target, writer, { hooks = {}, overwrite = true, suffix = ".partial", expectedModified, failCommit = false, backupRoot } = {}) {
  target = path.resolve(target);
  const original = await fs.lstat(target).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
  if (original && (!original.isFile() || original.isSymbolicLink())) throw new Error("Only regular files can be replaced; links and folders are not overwritten.");
  if (original && !overwrite) throw new Error("The destination already exists.");
  if (original && Number.isFinite(expectedModified) && Math.abs(original.mtimeMs - expectedModified) > 2) throw new Error("File changed on disk. Reload before saving, or save again with force.");
  const token = crypto.randomUUID();
  const staging = path.join(path.dirname(target), `.explore-better-staging-${token}${suffix}`);
  const backupDirectory = backupRoot ? path.join(backupRoot, `file-backups-${token}`) : path.dirname(target);
  const backup = original ? path.join(backupDirectory, backupRoot ? path.basename(target) : `.explore-better-backup-${token}-${path.basename(target)}`) : null;
  const before = original ? await pathSnapshot(target, { signal: hooks.signal }) : null;
  let committed = false;
  try {
    await writer(staging);
    const handle = await fs.open(staging, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    if (original) await fs.chmod(staging, original.mode).catch(() => {});
    const prepared = await pathSnapshot(staging, { signal: hooks.signal });
    if (before) {
      await fs.mkdir(backupDirectory, { recursive: true });
      await fs.copyFile(target, backup, 1);
      const backupHandle = await fs.open(backup, "r+");
      try { await backupHandle.sync(); } finally { await backupHandle.close(); }
      if ((await pathSnapshot(target, { signal: hooks.signal })).stateDigest !== before.stateDigest || (await pathSnapshot(backup, { signal: hooks.signal })).contentDigest !== before.contentDigest) throw new Error("File changed during save. Reload before retrying.");
    } else if (await fs.lstat(target).then(() => true, error => error.code === "ENOENT" ? false : Promise.reject(error))) {
      throw new Error("The destination appeared during the operation; it was not overwritten.");
    }
    const undo = backup ? { type: "replace-file-restore", path: target, backup, committedContentDigest: prepared.contentDigest } : { type: "trash-created", items: [{ path: target }] };
    const transaction = { version: 1, phase: "prepared", stagingPath: staging, destinationPath: target, backupPath: backup, committedContentDigest: prepared.contentDigest };
    await hooks.updateRecovery?.({ transaction, undo });
    throwIfAborted(hooks.signal);
    if (failCommit) throw new Error("Injected file transaction commit failure.");
    await fs.rename(staging, target);
    committed = true;
    const result = { path: target, transaction: { ...transaction, phase: "complete", stagingPath: null } };
    await hooks.updateRecovery?.({ ...result, undo });
    return { result, undo };
  } catch (error) {
    await fs.rm(staging, { force: true }).catch(() => {});
    if (!committed && backup) {
      await fs.rm(backup, { force: true }).catch(() => {});
      if (backupRoot) await fs.rmdir(backupDirectory).catch(() => {});
    }
    throw error;
  }
}
