import { deflateSync } from "node:zlib";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const outDir = path.join(workspace, "build");
const sizes = [16, 24, 32, 48, 64, 128, 256];

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buffers) {
  let c = 0xffffffff;
  for (const buffer of buffers) {
    for (const byte of buffer) {
      c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32([name, data]), 8 + data.length);
  return chunk;
}

function encodePng(width, height, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND")]);
}

function rgba(hex, alpha = 255) {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
    alpha
  ];
}

function blendPixel(pixels, width, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= width) return;
  const index = (Math.floor(y) * width + Math.floor(x)) * 4;
  const sourceAlpha = color[3] / 255;
  const destAlpha = pixels[index + 3] / 255;
  const outAlpha = sourceAlpha + destAlpha * (1 - sourceAlpha);
  if (outAlpha <= 0) return;
  pixels[index] = Math.round((color[0] * sourceAlpha + pixels[index] * destAlpha * (1 - sourceAlpha)) / outAlpha);
  pixels[index + 1] = Math.round((color[1] * sourceAlpha + pixels[index + 1] * destAlpha * (1 - sourceAlpha)) / outAlpha);
  pixels[index + 2] = Math.round((color[2] * sourceAlpha + pixels[index + 2] * destAlpha * (1 - sourceAlpha)) / outAlpha);
  pixels[index + 3] = Math.round(outAlpha * 255);
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function gradientColor(top, bottom, t, alpha = 255) {
  return [mix(top[0], bottom[0], t), mix(top[1], bottom[1], t), mix(top[2], bottom[2], t), alpha];
}

function roundedRect(pixels, width, x, y, rectWidth, rectHeight, radius, fill) {
  const x2 = x + rectWidth;
  const y2 = y + rectHeight;
  const minX = Math.max(0, Math.floor(x));
  const minY = Math.max(0, Math.floor(y));
  const maxX = Math.min(width, Math.ceil(x2));
  const maxY = Math.min(width, Math.ceil(y2));
  for (let py = minY; py < maxY; py += 1) {
    for (let px = minX; px < maxX; px += 1) {
      const cx = px < x + radius ? x + radius : px > x2 - radius ? x2 - radius : px;
      const cy = py < y + radius ? y + radius : py > y2 - radius ? y2 - radius : py;
      const inside = (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2;
      if (inside) blendPixel(pixels, width, px, py, typeof fill === "function" ? fill(px, py) : fill);
    }
  }
}

function rect(pixels, width, x, y, rectWidth, rectHeight, fill) {
  roundedRect(pixels, width, x, y, rectWidth, rectHeight, 0, fill);
}

function line(pixels, width, x1, y1, x2, y2, thickness, fill) {
  const minX = Math.floor(Math.min(x1, x2) - thickness);
  const maxX = Math.ceil(Math.max(x1, x2) + thickness);
  const minY = Math.floor(Math.min(y1, y2) - thickness);
  const maxY = Math.ceil(Math.max(y1, y2) + thickness);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
      const px = x1 + t * dx;
      const py = y1 + t * dy;
      if ((x - px) ** 2 + (y - py) ** 2 <= (thickness / 2) ** 2) {
        blendPixel(pixels, width, x, y, fill);
      }
    }
  }
}

function downsample(high, size, scale) {
  const pixels = Buffer.alloc(size * size * 4);
  const highWidth = size * scale;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let oy = 0; oy < scale; oy += 1) {
        for (let ox = 0; ox < scale; ox += 1) {
          const index = ((y * scale + oy) * highWidth + (x * scale + ox)) * 4;
          r += high[index];
          g += high[index + 1];
          b += high[index + 2];
          a += high[index + 3];
        }
      }
      const count = scale * scale;
      const out = (y * size + x) * 4;
      pixels[out] = Math.round(r / count);
      pixels[out + 1] = Math.round(g / count);
      pixels[out + 2] = Math.round(b / count);
      pixels[out + 3] = Math.round(a / count);
    }
  }
  return pixels;
}

function iconPixels(size) {
  const scale = 4;
  const width = size * scale;
  const pixels = Buffer.alloc(width * width * 4);
  const u = width / 256;
  const top = rgba("#15222d");
  const bottom = rgba("#0a1118");
  const panel = rgba("#edfaff", 236);
  const panelDark = rgba("#17242f", 232);
  const cyan = rgba("#1cc7ff", 255);
  const green = rgba("#55f0a2", 255);
  const yellow = rgba("#ffd166", 255);

  roundedRect(pixels, width, 13 * u, 13 * u, 230 * u, 230 * u, 43 * u, (_x, y) =>
    gradientColor(top, bottom, Math.max(0, Math.min(1, (y - 13 * u) / (230 * u))), 255)
  );
  roundedRect(pixels, width, 20 * u, 20 * u, 216 * u, 216 * u, 34 * u, rgba("#ffffff", 18));
  roundedRect(pixels, width, 31 * u, 42 * u, 194 * u, 154 * u, 16 * u, rgba("#071019", 198));

  roundedRect(pixels, width, 43 * u, 62 * u, 76 * u, 112 * u, 10 * u, panelDark);
  roundedRect(pixels, width, 137 * u, 62 * u, 76 * u, 112 * u, 10 * u, panelDark);
  rect(pixels, width, 43 * u, 62 * u, 76 * u, 19 * u, cyan);
  rect(pixels, width, 137 * u, 62 * u, 76 * u, 19 * u, green);
  roundedRect(pixels, width, 55 * u, 96 * u, 52 * u, 11 * u, 5 * u, panel);
  roundedRect(pixels, width, 55 * u, 119 * u, 42 * u, 11 * u, 5 * u, rgba("#bdeeff", 210));
  roundedRect(pixels, width, 55 * u, 142 * u, 49 * u, 11 * u, 5 * u, rgba("#bdeeff", 180));
  roundedRect(pixels, width, 149 * u, 96 * u, 51 * u, 11 * u, 5 * u, panel);
  roundedRect(pixels, width, 149 * u, 119 * u, 39 * u, 11 * u, 5 * u, rgba("#c8ffd9", 210));
  roundedRect(pixels, width, 149 * u, 142 * u, 45 * u, 11 * u, 5 * u, rgba("#c8ffd9", 180));

  roundedRect(pixels, width, 124 * u, 56 * u, 8 * u, 126 * u, 4 * u, rgba("#ffffff", 88));
  line(pixels, width, 70 * u, 194 * u, 112 * u, 209 * u, 9 * u, cyan);
  line(pixels, width, 112 * u, 209 * u, 185 * u, 185 * u, 9 * u, green);
  line(pixels, width, 183 * u, 185 * u, 168 * u, 171 * u, 8 * u, green);
  line(pixels, width, 183 * u, 185 * u, 177 * u, 206 * u, 8 * u, green);
  roundedRect(pixels, width, 92 * u, 32 * u, 72 * u, 16 * u, 8 * u, yellow);
  roundedRect(pixels, width, 110 * u, 28 * u, 36 * u, 8 * u, 4 * u, rgba("#ffffff", 150));

  return downsample(pixels, size, scale);
}

function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const image of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = image.size >= 256 ? 0 : image.size;
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.buffer.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((image) => image.buffer)]);
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const pngs = [];
  for (const size of sizes) {
    const png = encodePng(size, size, iconPixels(size));
    pngs.push({ size, buffer: png });
    await fs.writeFile(path.join(outDir, `icon-${size}.png`), png);
    if (size === 256) {
      await fs.writeFile(path.join(outDir, "icon.png"), png);
    }
  }
  await fs.writeFile(path.join(outDir, "icon.ico"), encodeIco(pngs));
  console.log(`generated ${pngs.length} PNG sizes and build\\icon.ico`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
