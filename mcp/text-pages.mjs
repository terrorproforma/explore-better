import { promises as fs } from "node:fs";

function pageError(code, message) {
  return Object.assign(new Error(message), { code });
}

export async function readTextPage(file, { offset = 0, maxBytes = 65_536, encoding = "auto" } = {}) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw pageError("BINARY_FILE", "Only regular text files can be read.");
    const header = Buffer.alloc(Math.min(512, stat.size));
    await handle.read(header, 0, header.length, 0);
    const automatic = encoding === "auto";
    if (automatic) {
      if (header[0] === 0xff && header[1] === 0xfe) encoding = "utf16le";
      else {
        const nulCount = header.reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0);
        if (nulCount > Math.max(2, header.length / 20)) throw pageError("BINARY_FILE", "Binary files are not returned by read_text.");
        encoding = "utf8";
      }
    }
    const start = Math.max(0, offset);
    const budget = Math.min(262_144, Math.max(1, maxBytes));
    const buffer = Buffer.alloc(Math.min(budget + 4, Math.max(0, stat.size - start)));
    const { bytesRead: available } = await handle.read(buffer, 0, buffer.length, start);
    let length = Math.min(budget, available);
    if (encoding === "utf16le") {
      if (start % 2) throw pageError("INVALID_ARGUMENT", "UTF-16 offsets must start on a two-byte character boundary.");
      if (available && start > 0 && available >= 2 && buffer.readUInt16LE(0) >= 0xdc00 && buffer.readUInt16LE(0) <= 0xdfff) {
        throw pageError("INVALID_ARGUMENT", "The offset splits a UTF-16 surrogate pair.");
      }
      length -= length % 2;
      if (!length && available >= 2) length = 2;
      if (length >= 2) {
        const last = buffer.readUInt16LE(length - 2);
        if (last >= 0xd800 && last <= 0xdbff) {
          if (length + 2 > available) throw pageError("INVALID_ARGUMENT", "The file ends with an incomplete UTF-16 surrogate pair.");
          if (length > 2) length -= 2; else length += 2;
        }
      }
      if (available && !length) throw pageError("INVALID_ARGUMENT", "The file ends with an incomplete UTF-16 character.");
    } else if (encoding === "utf8") {
      if (available && (buffer[0] & 0xc0) === 0x80) throw pageError("INVALID_ARGUMENT", "The offset splits a UTF-8 character.");
      if (length < available) {
        while (length > 0 && (buffer[length] & 0xc0) === 0x80) length -= 1;
        if (!length) {
          length = 1;
          while (length < available && (buffer[length] & 0xc0) === 0x80) length += 1;
        }
      }
    }
    const bytes = buffer.subarray(0, length);
    if (automatic && encoding === "utf8") {
      const nulCount = bytes.reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0);
      if (nulCount > Math.max(2, bytes.length / 20)) throw pageError("BINARY_FILE", "Binary files are not returned by read_text.");
    }
    let text;
    try {
      text = encoding === "utf8" ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) : bytes.toString(encoding);
    } catch {
      throw pageError("BINARY_FILE", "The requested bytes are not valid UTF-8 text. Select the file's encoding explicitly.");
    }
    return {
      path: file, offset: start, bytesRead: length, nextOffset: start + length,
      eof: start + length >= stat.size, encoding, modified: stat.mtimeMs,
      untrusted: true, text,
      ...(length > budget ? { warnings: ["The byte limit was extended to return one complete character."] } : {})
    };
  } finally {
    await handle.close();
  }
}
