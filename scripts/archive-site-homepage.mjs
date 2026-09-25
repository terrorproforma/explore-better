import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const date = String(process.argv[2] || "").trim();
const version = String(process.argv[3] || "").trim();

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  throw new Error("Usage: node scripts/archive-site-homepage.mjs YYYY-MM-DD [vX.Y.Z]");
}
if (version && !/^v\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("The optional archive version must look like v0.2.5");
}

const sourcePath = path.join(root, "site", "index.html");
const archiveName = version ? `legacy-${version}.html` : `legacy-${date}.html`;
const archivePath = path.join(root, "site", archiveName);
const displayDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC"
}).format(new Date(`${date}T00:00:00.000Z`));
const archiveDescription = version
  ? `Explore Better ${version} homepage from ${displayDate}`
  : `homepage from ${displayDate}`;
const archiveNotice = `Archived ${archiveDescription}`;

try {
  const existing = await fs.readFile(archivePath, "utf8");
  if (!existing.includes(archiveNotice)) {
    throw new Error(`${archiveName} already exists but is not the expected archive.`);
  }
  console.log(`${archiveName} already exists and is valid.`);
  process.exit(0);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const siteUrl = "https://terrorproforma.github.io/explore-better/";
const archiveUrl = `${siteUrl}${archiveName}`;
const archiveTitle = version
  ? `Explore Better ${version} - Legacy homepage snapshot, ${displayDate}`
  : `Explore Better - Legacy homepage snapshot, ${displayDate}`;
const source = await fs.readFile(sourcePath, "utf8");
let html = source;
html = html
  // Structured data would duplicate the live homepage's #website/#software entities.
  .replace(/[ \t]*<script type="application\/ld\+json">[\s\S]*?<\/script>\r?\n?/g, "")
  .replace(
    `<meta property="og:url" content="${siteUrl}" />`,
    `<meta property="og:url" content="${archiveUrl}" />`
  )
  .replace(
    /<meta name="robots" content="[^"]+" \/>/,
    '<meta name="robots" content="noindex,nofollow" />'
  )
  .replace(
    /<meta name="googlebot" content="[^"]+" \/>/,
    '<meta name="googlebot" content="noindex,nofollow" />'
  )
  .replace(
    /<title>[^<]+<\/title>/,
    `<title>${archiveTitle}</title>`
  )
  .replace(
    `<link rel="canonical" href="${siteUrl}" />`,
    `<link rel="canonical" href="${archiveUrl}" />`
  )
  .replace(
    /<body[^>]*>/,
    (body) => `${body}\n    <aside class="legacy-notice" aria-label="Archived page notice">\n      ${archiveNotice}. All original content is preserved here.\n      <a href="index.html">Return to the current homepage</a>\n    </aside>`
  );

// Archives must keep looking the way they did, so the live stylesheet and script are frozen
// into legacy-assets/ beside the snapshot instead of being shared with the evolving site.
// (Archives made before site.css existed use the frozen styles.css and script.js.)
const archiveBase = archiveName.replace(/\.html$/, "");
const frozenAssets = [];
for (const [live, extension] of [["site.css", "css"], ["site.js", "js"]]) {
  const reference = extension === "css" ? `href="${live}"` : `src="${live}"`;
  if (!html.includes(reference)) continue;
  const frozen = `legacy-assets/${archiveBase}.${extension}`;
  frozenAssets.push([path.join(root, "site", live), path.join(root, "site", ...frozen.split("/"))]);
  html = html.replace(reference, extension === "css" ? `href="${frozen}"` : `src="${frozen}"`);
}

if (
  !html.includes(archiveNotice) ||
  !html.includes('content="noindex,nofollow"') ||
  !html.includes(`<title>${archiveTitle}</title>`) ||
  !html.includes(`<link rel="canonical" href="${archiveUrl}" />`) ||
  !html.includes(`<meta property="og:url" content="${archiveUrl}" />`) ||
  html.includes("application/ld+json")
) {
  throw new Error("Could not apply the archive notice, title, URLs, and indexing protections.");
}

// Point the live homepage's "Previous Homepage" footer link at the snapshot just taken.
const previousLink = /<a href="legacy-[^"]+\.html">Previous Homepage<\/a>/;
if (!previousLink.test(source)) throw new Error("site/index.html has no Previous Homepage footer link to update.");
const homepage = source.replace(previousLink, `<a href="${archiveName}">Previous Homepage</a>`);

for (const [source, target] of frozenAssets) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}
await fs.writeFile(archivePath, html, "utf8");
if (homepage !== source) await fs.writeFile(sourcePath, homepage, "utf8");
console.log(`Archived site/index.html as site/${archiveName} and linked it as the Previous Homepage.`);
