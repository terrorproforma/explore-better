// Shared helpers for the website's per-feature video clips.
//
// site/assets/features/features.json lists the clips ({ version: 1, clips: [{ id, title,
// summary, src, poster, width, height, durationSeconds, alt }] }). Pages embed each clip as
// static markup, so visitors without JavaScript and crawlers see the poster and alt text; the
// markup is written by scripts/build-feature-media.mjs (hand-written pages) and
// scripts/build-site-discovery-pages.mjs (generated pages). site.js adds playback.
import { promises as fs } from "node:fs";
import path from "node:path";

export const baseUrl = "https://terrorproforma.github.io/explore-better";
export const featuresPath = path.join("site", "assets", "features", "features.json");
// Upload date of the recorded clips, used by every VideoObject.
export const clipUploadDate = "2026-09-25T00:00:00Z";

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function isFile(file) {
  return fs.stat(file).then((stat) => stat.isFile() && stat.size > 0).catch(() => false);
}

// Returns a Map of id -> clip for every listed clip whose video and poster both exist.
// `problems` collects why a listed clip was skipped; a missing manifest yields an empty map.
export async function loadFeatureClips(root = process.cwd(), problems = []) {
  const siteRoot = path.join(root, "site");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(root, featuresPath), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") problems.push(`features.json is unreadable: ${error.message}`);
    return new Map();
  }
  const clips = new Map();
  for (const clip of Array.isArray(manifest?.clips) ? manifest.clips : []) {
    const id = String(clip?.id || "");
    const valid = /^[a-z0-9-]+$/.test(id) && /^assets\/features\/[\w.-]+\.mp4$/.test(clip.src || "") &&
      /^assets\/features\/[\w.-]+\.(webp|jpg|png)$/.test(clip.poster || "") &&
      Number(clip.width) > 0 && Number(clip.height) > 0 && Number(clip.durationSeconds) > 0 && clip.alt && clip.title;
    if (!valid) {
      problems.push(`clip ${id || "(no id)"} does not follow the features.json contract`);
      continue;
    }
    if (!(await isFile(path.join(siteRoot, clip.src))) || !(await isFile(path.join(siteRoot, clip.poster)))) {
      problems.push(`clip ${id} is missing ${clip.src} or ${clip.poster}`);
      continue;
    }
    clips.set(id, { ...clip, width: Number(clip.width), height: Number(clip.height), durationSeconds: Number(clip.durationSeconds) });
  }
  return clips;
}

// The media for one clip: a lazy poster image under a transparent <video>. Chromium fetches a
// <video poster> as soon as the element is parsed, which would download every poster on the
// homepage up front; a loading="lazy" <img> in the same grid cell shows the same frame, is
// fetched only near the viewport, and stays visible (and crawlable) without JavaScript. The
// video has no autoplay attribute: site.js plays clips while they are on screen (never under
// reduced motion or Save-Data) and replaces `controls`, which keeps no-JS clips playable.
export function clipMedia(clip, prefix = "") {
  return `<img class="clip__poster" src="${prefix}${esc(clip.poster)}" alt="" width="${clip.width}" height="${clip.height}" loading="lazy" decoding="async" />` +
    `<video data-clip-video muted loop playsinline controls preload="none" width="${clip.width}" height="${clip.height}" data-duration="${clip.durationSeconds}" data-title="${esc(clip.title)}" aria-label="${esc(clip.alt)}"><source src="${prefix}${esc(clip.src)}" type="video/mp4" /></video>`;
}

// A standalone clip figure, used by generated pages.
export function clipFigure(clip, { prefix = "", className = "", caption = "" } = {}) {
  const captionHtml = caption ? `<figcaption><p>${caption}</p></figcaption>` : "";
  return `<figure class="clip${className ? ` ${className}` : ""}" id="clip-${clip.id}" data-clip>${clipMedia(clip, prefix)}${captionHtml}</figure>`;
}

// schema.org VideoObject for one clip. `pageUrl` is the canonical page showing it.
export function clipVideoObject(clip, pageUrl) {
  return {
    "@type": "VideoObject",
    "@id": `${pageUrl}#clip-${clip.id}`,
    name: clip.title,
    description: clip.summary || clip.alt,
    thumbnailUrl: `${baseUrl}/${clip.poster}`,
    contentUrl: `${baseUrl}/${clip.src}`,
    uploadDate: clipUploadDate,
    duration: `PT${clip.durationSeconds}S`,
    about: { "@id": `${baseUrl}/#software` }
  };
}
