import { deflateSync } from "node:zlib";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const outDir = path.join(workspace, "build");
const brandAssetDirs = [path.join(workspace, "site", "assets"), path.join(workspace, "public", "assets")];
const sizes = [16, 24, 32, 48, 64, 128, 256];

const brandShapes = [
  { x: 8, y: 8, width: 240, height: 240, radius: 34, fill: "#f4f7f5" },
  { x: 14, y: 14, width: 228, height: 228, radius: 29, fill: "#111715" },
  { x: 47, y: 51, width: 27, height: 154, fill: "#f4f7f5" },
  { x: 47, y: 51, width: 70, height: 25, fill: "#f4f7f5" },
  { x: 47, y: 116, width: 58, height: 24, fill: "#f4f7f5" },
  { x: 47, y: 180, width: 70, height: 25, fill: "#f4f7f5" },
  { x: 122, y: 51, width: 7, height: 154, fill: "#20b8a5" },
  { x: 136, y: 51, width: 26, height: 154, fill: "#c7ff4a" },
  { x: 136, y: 51, width: 51, height: 25, fill: "#c7ff4a" },
  { x: 181, y: 68, width: 27, height: 56, fill: "#c7ff4a" },
  { x: 136, y: 116, width: 59, height: 24, fill: "#c7ff4a" },
  { x: 184, y: 133, width: 27, height: 56, fill: "#c7ff4a" },
  { x: 136, y: 180, width: 54, height: 25, fill: "#c7ff4a" }
];

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
  for (const shape of brandShapes) {
    roundedRect(
      pixels,
      width,
      shape.x * u,
      shape.y * u,
      shape.width * u,
      shape.height * u,
      (shape.radius || 0) * u,
      rgba(shape.fill)
    );
  }

  return downsample(pixels, size, scale);
}

function brandMarkSvg() {
  const shapes = brandShapes
    .map((shape) => {
      const radius = shape.radius ? ` rx="${shape.radius}"` : "";
      return `  <rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}"${radius} fill="${shape.fill}"/>`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-labelledby="title desc">
  <title id="title">Explore Better</title>
  <desc id="desc">Geometric EB monogram divided like a dual-pane file manager.</desc>
${shapes}
</svg>
`;
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
  await Promise.all(brandAssetDirs.map((directory) => fs.mkdir(directory, { recursive: true })));
  const svg = brandMarkSvg();
  await Promise.all(brandAssetDirs.map((directory) => fs.writeFile(path.join(directory, "brand-mark.svg"), svg)));
  const pngs = [];
  for (const size of sizes) {
    const png = encodePng(size, size, iconPixels(size));
    pngs.push({ size, buffer: png });
    await fs.writeFile(path.join(outDir, `icon-${size}.png`), png);
    if (size === 256) {
      await fs.writeFile(path.join(outDir, "icon.png"), png);
      await Promise.all(brandAssetDirs.map((directory) => fs.writeFile(path.join(directory, "app-icon.png"), png)));
    }
  }
  await fs.writeFile(path.join(outDir, "icon.ico"), encodeIco(pngs));
  console.log(`generated Explore Better brand SVG, ${pngs.length} PNG sizes, and build\\icon.ico`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
