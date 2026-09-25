// Writes the per-feature video clips from site/assets/features/features.json into the website.
//
// Hand-written pages mark where each clip's poster and <video> go with
// <!-- clip:ID --><!-- /clip:ID --> inside a <figure class="clip" data-clip>, and hold
// one <!-- feature-videos:jsonld --><!-- /feature-videos:jsonld --> pair in <head>; this
// script fills the markers with the clip markup and a VideoObject for every clip on the page.
// It also rewrites the "## Feature Videos" list in llms-full.txt and then regenerates the
// discovery pages, whose template (scripts/build-site-discovery-pages.mjs) embeds clips too.
// Re-running with the same features.json changes nothing.
//
// Usage: node scripts/build-feature-media.mjs            (write)
//        node scripts/build-feature-media.mjs --check    (fail if a page is out of date)
//        node scripts/build-feature-media.mjs --skip-pages
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { baseUrl, clipMedia, clipVideoObject, loadFeatureClips } from "./feature-clips.mjs";

const root = process.cwd();
const siteRoot = path.join(root, "site");
const check = process.argv.includes("--check");
const pages = [
  { file: "index.html", url: `${baseUrl}/`, prefix: "" },
  { file: path.join("mcp", "index.html"), url: `${baseUrl}/mcp/`, prefix: "../" }
];

const problems = [];
const clips = await loadFeatureClips(root, problems);
if (!clips.size) {
  console.error(`No usable clips in site/assets/features/features.json.${problems.length ? `\n${problems.join("\n")}` : ""}`);
  process.exit(1);
}

const clipMarker = /<!-- clip:([a-z0-9-]+) -->[\s\S]*?<!-- \/clip:\1 -->/g;
const jsonLdMarker = /([ \t]*)<!-- feature-videos:jsonld -->[\s\S]*?<!-- \/feature-videos:jsonld -->/;

function renderPage(html, page) {
  const eol = html.includes("\r\n") ? "\r\n" : "\n";
  const used = [];
  const missing = [];
  let result = html.replace(clipMarker, (match, id) => {
    const clip = clips.get(id);
    if (!clip) {
      missing.push(id);
      return match;
    }
    if (!used.includes(clip)) used.push(clip);
    return `<!-- clip:${id} -->${clipMedia(clip, page.prefix)}<!-- /clip:${id} -->`;
  });
  if (missing.length) throw new Error(`${page.file}: no usable clip for ${missing.join(", ")}.${problems.length ? ` ${problems.join("; ")}` : ""}`);
  const indent = jsonLdMarker.exec(result)?.[1];
  if (indent === undefined) throw new Error(`${page.file}: missing the <!-- feature-videos:jsonld --> marker.`);
  // A separate block (not the page's main @graph) so this script owns it outright. The
  // archive script strips every ld+json block, so snapshots never duplicate these entities.
  // One VideoObject per line keeps the homepage's 13 entries compact and diff-friendly.
  const nodes = used.map((clip, index) => `    ${JSON.stringify(clipVideoObject(clip, page.url))}${index < used.length - 1 ? "," : ""}`);
  const json = ["{", '  "@context": "https://schema.org",', '  "@graph": [', ...nodes, "  ]", "}"].map((line) => `${indent}  ${line}`).join(eol);
  const block = `${indent}<!-- feature-videos:jsonld -->${eol}${indent}<script type="application/ld+json">${eol}${json}${eol}${indent}</script>${eol}${indent}<!-- /feature-videos:jsonld -->`;
  result = result.replace(jsonLdMarker, () => block);
  return { html: result, used };
}

function renderLlms(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const section = /(## Feature Videos)[\s\S]*?(?=\r?\n## )/;
  if (!section.test(text)) throw new Error("llms-full.txt: missing the ## Feature Videos heading.");
  const lines = [...clips.values()].map((clip) => `- ${clip.title} (${clip.durationSeconds} s): ${clip.summary || clip.alt} ${baseUrl}/${clip.src}`);
  const body = ["## Feature Videos", "", "Short silent recordings of the real app, each a loop of a single feature. Posters use the same name with a .webp extension.", "", ...lines, ""].join(eol);
  return text.replace(section, () => body);
}

const writes = [];
for (const page of pages) {
  const target = path.join(siteRoot, page.file);
  const before = await fs.readFile(target, "utf8");
  const { html, used } = renderPage(before, page);
  writes.push({ target, before, after: html, detail: `${used.length} clip(s)` });
}
{
  const target = path.join(siteRoot, "llms-full.txt");
  const before = await fs.readFile(target, "utf8");
  writes.push({ target, before, after: renderLlms(before), detail: `${clips.size} clip(s)` });
}

const stale = writes.filter((write) => write.before !== write.after);
if (check) {
  for (const write of stale) console.error(`${path.relative(root, write.target)} is out of date; run npm run build:feature-media`);
  if (stale.length) process.exitCode = 1;
  else console.log(`Feature media up to date (${clips.size} clips).`);
} else {
  for (const write of stale) await fs.writeFile(write.target, write.after, "utf8");
  for (const write of writes) console.log(`${path.relative(root, write.target)}: ${write.detail}${stale.includes(write) ? " (updated)" : ""}`);
  if (!process.argv.includes("--skip-pages")) {
    execFileSync(process.execPath, [path.join(root, "scripts", "build-site-discovery-pages.mjs")], { cwd: root, stdio: "inherit" });
  }
}
if (problems.length) console.warn(`Skipped: ${problems.join("; ")}`);
