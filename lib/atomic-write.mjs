import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";

const transientCodes = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY", "EEXIST"]);

export function isTransientFileError(error) {
  return transientCodes.has(error?.code);
}

// Rename with short retries for antivirus/indexer locks that are common on Windows.
export async function renameWithRetry(source, dest, attempts = 8) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, dest);
      return;
    } catch (error) {
      if (!isTransientFileError(error) || attempt >= attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

// Write through a uniquely named sibling temp file, then rename over the target.
// The temp file is always removed on failure.
export async function writeFileAtomic(target, data, { encoding = "utf8", mode, fsync = false } = {}) {
  const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await fs.open(temp, "w", mode);
    try {
      await handle.writeFile(data, typeof data === "string" ? { encoding } : undefined);
      if (fsync) await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeJsonAtomic(target, value, options = {}) {
  await writeFileAtomic(target, JSON.stringify(value), options);
}
