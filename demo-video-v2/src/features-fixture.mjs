// Disposable fixture for the per-feature website clips (npm run capture:features).
// Every file is generated here; nothing is read from the capturing machine except the
// STEP assembly, which is a public CAx-IF test model that ships with occt-import-js.
import path from "node:path";
import zlib from "node:zlib";
import { existsSync, promises as fs } from "node:fs";

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

export function sizedFile(bytes, seed) {
  bytes = Math.round(bytes);
  const buffer = Buffer.allocUnsafe(bytes);
  let state = seed * 2654435761 >>> 0;
  for (let index = 0; index < bytes; index += 4096) {
    state = (state * 1664525 + 1013904223) >>> 0;
    buffer.fill(state & 0xff, index, Math.min(bytes, index + 4096));
  }
  return buffer;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

const mix = (a, b, t) => Math.round(a + (b - a) * Math.min(1, Math.max(0, t)));
const mixRgb = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

// Real image data followed by padding, so thumbnails decode and the file still weighs something.
export const padded = (png, bytes) => Buffer.concat([png, Buffer.alloc(Math.max(0, Math.round(bytes) - png.length))]);

// A procedural dusk landscape: sky gradient, sun, and layered ridgelines.
export function landscapePng(width = 960, height = 600, sunX = 0.68) {
  const ridges = [
    { base: 0.52, amp: 0.07, freq: [2.1, 5.3, 11.7], color: [70, 96, 104] },
    { base: 0.62, amp: 0.06, freq: [3.3, 7.9, 17.1], color: [44, 66, 70] },
    { base: 0.73, amp: 0.05, freq: [2.7, 9.1, 21.3], color: [28, 44, 44] },
    { base: 0.85, amp: 0.04, freq: [4.1, 12.3, 29.9], color: [17, 23, 21] }
  ];
  const ridgeY = (ridge, u) => ridge.base - ridge.amp * (Math.sin(u * ridge.freq[0] + ridge.base * 9) * 0.6 + Math.sin(u * ridge.freq[1] + 1.3) * 0.3 + Math.sin(u * ridge.freq[2] + 0.7) * 0.1);
  return encodePng(width, height, (x, y) => {
    const u = x / width;
    const v = y / height;
    let color = v < 0.5 ? mixRgb([34, 52, 74], [236, 170, 110], v / 0.5) : [236, 170, 110];
    const dx = u - sunX;
    const dy = v - 0.42;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.07) color = mixRgb([255, 236, 190], [250, 214, 150], d / 0.07);
    else if (d < 0.2) color = mixRgb(color, [255, 214, 160], (0.2 - d) / 0.13 * 0.35);
    for (const [index, ridge] of ridges.entries()) {
      if (v > ridgeY(ridge, u * Math.PI)) color = mixRgb(ridge.color, [199, 255, 74], index === 3 ? 0 : (v - ridge.base) * 0.08);
    }
    return color;
  });
}

// A single-page PDF built by hand (valid xref, standard Helvetica).
export function briefPdf() {
  const lines = [
    ["F2", 26, 72, 720, "Spring launch brief"],
    ["F1", 12, 72, 694, "Explore Better / Project files / 04 Launch"],
    ["F2", 14, 72, 640, "Goals"],
    ["F1", 12, 90, 618, "- Ship 0.2.8 with the transfer preview and disk map"],
    ["F1", 12, 90, 600, "- Publish signed installers and checksums"],
    ["F1", 12, 90, 582, "- Brief press on the scoped AI Bridge"],
    ["F2", 14, 72, 540, "Timeline"],
    ["F1", 12, 90, 518, "Mon  Freeze copy and screenshots"],
    ["F1", 12, 90, 500, "Wed  Final exports and release notes"],
    ["F1", 12, 90, 482, "Fri  Announce"],
    ["F2", 14, 72, 440, "Owners"],
    ["F1", 12, 90, 418, "Design: brand + site    Engineering: release    Ops: support"]
  ];
  const text = lines.map(([font, size, x, y, value]) => `BT /${font} ${size} Tf ${x} ${y} Td (${value}) Tj ET`).join("\n");
  const stream = `0.067 0.090 0.082 rg 0 752 612 40 re f\n0.78 1 0.29 rg 72 706 120 5 re f\n0.78 1 0.29 rg 72 300 468 90 re f\n0.067 0.090 0.082 rg\n${text}\nBT /F2 16 Tf 90 356 Td (Fast. Local-first. Visible. Recoverable.) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

export async function createFeatureFixture(demoRoot, repoRoot) {
  const user = path.join(demoRoot, "User");
  const left = path.join(demoRoot, "Project files");
  const right = path.join(demoRoot, "Release ready");
  const now = Date.now();
  const recent = (days) => new Date(now - days * DAY);
  const files = [
    // [relative path, contents, age in days]
    ["User/Desktop/todo.txt", "Review final exports\n", 1],
    ["User/Documents/Notes/ideas.md", "# Ideas\n", 3],
    ["User/Downloads/sample-dataset.csv", "id,value\n1,42\n", 2],
    ["User/AppData/Local/.keep", "", 1],
    ["User/AppData/Roaming/.keep", "", 1],

    ["Project files/README.md", "# Spring launch workspace\n\nSource assets, research and release planning for the spring launch.\n\n- 01 Brand: logos, palette, guidelines\n- 02 Product: screens and walkthrough videos\n- 03 Research: survey data and interview notes\n- 04 Launch: press kit, timeline, checklist\n\nOwners: design, engineering, ops.\n", 2],
    ["Project files/launch-plan.md", "# Launch plan\n\n1. Freeze copy and screenshots\n2. Export final videos\n3. Publish release notes\n4. Send press kit\n", 4],
    ["Project files/meeting-notes.txt", "Weekly sync\n- Final exports due Friday\n- Press kit review with design\n- Confirm launch timeline\n", 5],
    ["Project files/launch-brief.pdf", briefPdf(), 3],
    ["Project files/dusk-hero.png", landscapePng(), 2],
    ["Project files/budget-2026.xlsx", sizedFile(0.34 * MB, 22), 20],
    ["Project files/01 Brand/logo-primary.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200"><rect width="100%" height="100%" rx="24" fill="#111715"/><circle cx="100" cy="100" r="54" fill="#c7ff4a"/><text x="184" y="124" fill="#f4f7f2" font-family="Segoe UI" font-size="64">Spring Launch</text></svg>\n', 40],
    ["Project files/01 Brand/brand-guidelines.pdf", sizedFile(6.8 * MB, 31), 45],
    ["Project files/01 Brand/icon-set.zip", sizedFile(7.4 * MB, 32), 3],
    ["Project files/01 Brand/color-palette.pdf", sizedFile(1.2 * MB, 33), 50],
    ["Project files/02 Product/workspace-tour.mp4", sizedFile(48 * MB, 41), 2],
    ["Project files/02 Product/onboarding-walkthrough.mp4", sizedFile(31 * MB, 42), 60],
    ["Project files/02 Product/ui-kit.fig", sizedFile(9.2 * MB, 43), 5],
    ["Project files/02 Product/Renders/hero-4k.png", padded(landscapePng(800, 500), 18 * MB), 6],
    ["Project files/02 Product/Renders/hero-1080p.png", padded(landscapePng(640, 400, 0.3), 5.6 * MB), 6],
    ["Project files/02 Product/Renders/hero-square.png", padded(landscapePng(480, 480, 0.5), 2.4 * MB), 6],
    ["Project files/02 Product/Renders/banner-wide.png", padded(landscapePng(900, 300, 0.82), 1.9 * MB), 6],
    ["Project files/02 Product/Renders/turntable.mov", sizedFile(26 * MB, 46), 30],
    ["Project files/03 Research/survey-results-2026.csv", `respondent,segment,score\n${Array.from({ length: 4000 }, (_, i) => `${1000 + i},${["design", "engineering", "ops", "sales"][i % 4]},${(i * 7) % 10}`).join("\n")}\n`, 12],
    ["Project files/03 Research/interview-notes.md", "# Interview notes\n\n- Wants faster search across project folders\n- Uses two windows side by side for every copy\n- Needs to see what a move will overwrite first\n", 12],
    ["Project files/03 Research/usability-sessions.mov", sizedFile(22 * MB, 51), 25],
    ["Project files/03 Research/Recordings/session-01.wav", sizedFile(9.8 * MB, 52), 26],
    ["Project files/03 Research/Recordings/session-02.wav", sizedFile(11.2 * MB, 53), 26],
    ["Project files/04 Launch/press-kit.zip", sizedFile(14 * MB, 61), 1],
    ["Project files/04 Launch/release-checklist.md", "# Release checklist\n\n[x] Signed installer\n[x] Checksums published\n[x] Update feed live\n[ ] Announce\n", 1],
    ["Project files/04 Launch/announcement-draft.md", "Explore Better 0.2.8 is here.\n", 1],
    ["Project files/04 Launch/launch-timeline.pdf", sizedFile(0.9 * MB, 62), 8],
    ["Project files/bracket-assembly.step", null, 4],
    ["Project files/Archive/2024/campaign-assets.zip", sizedFile(38 * MB, 71), 300],
    ["Project files/Archive/2024/website-backup.zip", sizedFile(27 * MB, 72), 280],
    ["Project files/Archive/2025/q3-review-deck.pptx", sizedFile(12 * MB, 73), 120],
    ["Project files/Archive/2025/explore-better-v1.exe", sizedFile(11.4 * MB, 74), 150],

    // Website pair for Compare + Sync: identical, newer on the left, left-only and right-only.
    ["Project files/Website/index.html", "<!doctype html><title>Spring launch</title><h1>Spring launch</h1>\n<p>New hero and download button.</p>\n", 1],
    ["Project files/Website/styles.css", "body { font-family: system-ui; }\n", 30],
    ["Project files/Website/app.js", "console.log('launch');\n", 30],
    ["Project files/Website/pricing.html", "<!doctype html><title>Pricing</title>\n", 2],
    ["Project files/Website/assets/hero.png", sizedFile(0.8 * MB, 91), 2],
    ["Project files/Website/assets/logo.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n", 30],
    ["Release ready/Website/index.html", "<!doctype html><title>Spring launch</title><h1>Coming soon</h1>\n", 20],
    ["Release ready/Website/styles.css", "body { font-family: system-ui; }\n", 30],
    ["Release ready/Website/app.js", "console.log('launch');\n", 30],
    ["Release ready/Website/old-banner.png", sizedFile(0.4 * MB, 92), 40],
    ["Release ready/Website/assets/logo.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n", 30],

    ["Release ready/launch-plan.md", "# Launch plan (draft)\n\n1. Collect assets\n2. Review copy\n", 9],
    ["Release ready/meeting-notes.txt", "Weekly sync (old)\n", 9],
    ["Release ready/Approved/release-notes.md", "# Release notes\n\nFaster search, clearer transfers, and a new disk map.\n", 6],
    ["Release ready/Final exports/product-overview.pdf", sizedFile(4.2 * MB, 82), 6],
    ["Release ready/Final exports/ExploreBetter-0.2.8-x64.exe", sizedFile(14.2 * MB, 83), 3]
  ];
  for (const [relative, contents, age] of files) {
    const target = path.join(demoRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (contents === null) {
      await fs.copyFile(path.join(repoRoot, "node_modules", "occt-import-js", "test", "testfiles", "cax-if", "as1-oc-214.stp"), target);
    } else {
      await fs.writeFile(target, contents);
    }
    await fs.utimes(target, recent(age), recent(age));
  }
  // Photos for the transfer clip: enough for a few seconds of live progress. Three already
  // exist on the release side, so the preview has real conflicts to resolve.
  const picks = path.join(left, "Client picks");
  const rightPicks = path.join(right, "Client picks");
  await fs.mkdir(picks, { recursive: true });
  await fs.mkdir(rightPicks, { recursive: true });
  for (let index = 0; index < 360; index += 1) {
    const file = path.join(picks, `IMG_${4100 + index}.jpg`);
    await fs.writeFile(file, sizedFile(90_000 + (index % 9) * 22_000, 100 + index));
    await fs.utimes(file, recent(7), recent(7));
  }
  for (const index of [0, 1, 2]) {
    const file = path.join(rightPicks, `IMG_${4100 + index}.jpg`);
    await fs.writeFile(file, sizedFile(80_000, 900 + index));
    await fs.utimes(file, recent(14), recent(14));
  }
  return { user, left, right, picks, rightPicks };
}

// 100,000 small files, written with a bounded number of concurrent writes.
export async function createLargeFolder(folder, count = 100_000) {
  if (existsSync(folder)) await fs.rm(folder, { recursive: true, force: true });
  await fs.mkdir(folder, { recursive: true });
  const width = 32;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      const name = `reading-${String(index + 1).padStart(6, "0")}.csv`;
      await fs.writeFile(path.join(folder, name), `sensor,${index % 97},${(index * 31) % 1000}\n`.repeat(1 + (index % 7)));
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
}
