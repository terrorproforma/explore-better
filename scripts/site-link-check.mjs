// Checks that every local link in the published website resolves.
//
// For each site/**/*.html page (including the frozen legacy archives) it follows href, src,
// poster, and srcset references plus absolute URLs on the canonical origin (meta tags, JSON-LD,
// sitemap.xml, llms*.txt). Each must name an existing file, and a #fragment must name an
// element id on the target page (or be a #t=<seconds> video deep link on the homepage).
import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const siteRoot = path.join(root, "site");
const canonicalRoot = "https://terrorproforma.github.io/explore-better/";

async function walk(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else files.push(target);
  }
  return files;
}

const allFiles = await walk(siteRoot);
const htmlFiles = allFiles.filter((file) => file.endsWith(".html"));
const idCache = new Map();

async function idsOf(file) {
  if (!idCache.has(file)) {
    const html = await fs.readFile(file, "utf8");
    idCache.set(file, new Set([...html.matchAll(/\s(?:id|name)="([^"]+)"/g)].map((match) => match[1])));
  }
  return idCache.get(file);
}

async function exists(file) {
  return fs.stat(file).then((stat) => stat.isFile()).catch(() => false);
}

function decode(value) {
  return value.replaceAll("&amp;", "&");
}

// Returns a problem description, or "" when the reference resolves.
async function check(fromFile, reference) {
  const value = decode(reference.trim());
  if (!value || /^(mailto:|tel:|data:|javascript:)/i.test(value)) return "";
  let target;
  let fragment = "";
  if (/^https?:\/\//i.test(value)) {
    if (!value.startsWith(canonicalRoot)) return "";
    const url = new URL(value);
    fragment = decodeURIComponent(url.hash.slice(1));
    target = path.join(siteRoot, decodeURIComponent(url.pathname.slice(new URL(canonicalRoot).pathname.length)));
    if (url.pathname.endsWith("/")) target = path.join(target, "index.html");
  } else if (value.startsWith("//")) {
    return "";
  } else {
    const [withoutHash, hash = ""] = value.split("#");
    fragment = decodeURIComponent(hash);
    const withoutQuery = withoutHash.split("?")[0];
    if (!withoutQuery) target = fromFile;
    else {
      target = path.resolve(path.dirname(fromFile), decodeURIComponent(withoutQuery));
      if (withoutQuery.endsWith("/")) target = path.join(target, "index.html");
    }
  }
  if (target !== siteRoot && !target.startsWith(`${siteRoot}${path.sep}`)) return `${value} leaves the site root`;
  if (!(await exists(target))) return `${value} -> missing ${path.relative(root, target)}`;
  if (fragment && target.endsWith(".html")) {
    if (/^t=\d+(\.\d+)?$/.test(fragment) && path.basename(target) === "index.html") return "";
    if (!(await idsOf(target)).has(fragment)) return `${value} -> no #${fragment} in ${path.relative(root, target)}`;
  }
  return "";
}

const problems = [];
let checked = 0;
for (const file of htmlFiles) {
  const html = await fs.readFile(file, "utf8");
  const references = [
    ...[...html.matchAll(/\s(?:href|src|poster)="([^"]*)"/g)].map((match) => match[1]),
    ...[...html.matchAll(/\ssrcset="([^"]*)"/g)].flatMap((match) => match[1].split(",").map((part) => part.trim().split(/\s+/)[0])),
    // Canonical URLs in meta tags and JSON-LD. Their fragments are schema.org @id node
    // identifiers (#software, #website), not page anchors, so only the file is checked.
    ...[...html.matchAll(/https:\/\/terrorproforma\.github\.io\/explore-better\/[^\s"'<>)#]*/g)].map((match) => match[0])
  ];
  for (const reference of new Set(references)) {
    checked += 1;
    const problem = await check(file, reference);
    if (problem) problems.push(`${path.relative(root, file)}: ${problem}`);
  }
}

for (const name of ["sitemap.xml", "llms.txt", "llms-full.txt", "robots.txt"]) {
  const file = path.join(siteRoot, name);
  const text = await fs.readFile(file, "utf8").catch(() => "");
  for (const match of new Set([...text.matchAll(/https:\/\/terrorproforma\.github\.io\/explore-better\/[^\s"'<>)\]]*/g)].map((m) => m[0].replace(/[.,;:]+$/, "")))) {
    checked += 1;
    const problem = await check(path.join(siteRoot, "index.html"), match);
    if (problem) problems.push(`site/${name}: ${problem}`);
  }
}

console.log(`site link check: ${checked} references in ${htmlFiles.length} pages and 4 discovery files, ${problems.length} broken`);
for (const problem of problems) console.error(`BROKEN ${problem}`);
if (problems.length) process.exitCode = 1;
