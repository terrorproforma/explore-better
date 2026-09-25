import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const siteRoot = path.join(workspace, "site");
const artifactsDir = path.join(workspace, "artifacts");
const reportPath = path.join(artifactsDir, "landing-page-latest.json");
const markdownPath = path.join(artifactsDir, "landing-page-latest.md");
const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 }
];

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};
const expectedHeadline = "Fast for you. Safe for your AI.";
const requiredSections = ["top", "demo", "features", "ai", "safety", "proof", "release", "download", "faq"];

function browserPath() {
  return (
    process.env.EB_LANDING_PAGE_BROWSER ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  );
}

function addCheck(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const target = path.resolve(siteRoot, `.${relative}`);
      if (target !== siteRoot && !target.startsWith(`${siteRoot}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const bytes = await fs.readFile(target);
      const type = mimeTypes[path.extname(target).toLowerCase()] || "application/octet-stream";
      // Byte ranges, as GitHub Pages serves them, so the demo video can seek.
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || "");
      if (range) {
        const start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        response.writeHead(206, {
          "content-type": type,
          "content-range": `bytes ${start}-${end}/${bytes.length}`,
          "accept-ranges": "bytes",
          "cache-control": "no-store"
        });
        response.end(bytes.subarray(start, end + 1));
        return;
      }
      response.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-store" });
      response.end(bytes);
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500).end("Not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
  };
}

async function pageSnapshot(page, installerName) {
  return page.evaluate((expectedInstallerName) => {
    const viewportWidth = window.innerWidth;
    const elements = [...document.querySelectorAll("body *")].filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    const offenders = elements
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === "string" ? element.className : "",
          left: Math.round(rect.left),
          right: Math.round(rect.right)
        };
      })
      .filter((item) => item.left < -2 || item.right > viewportWidth + 2)
      .slice(0, 12);
    const images = [...document.images].map((image) => ({
      src: image.getAttribute("src"),
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      renderedWidth: Math.round(image.getBoundingClientRect().width),
      renderedHeight: Math.round(image.getBoundingClientRect().height)
    }));
    const aspectIssues = [...document.images]
      .filter((image) => image.naturalWidth >= 300)
      .map((image) => {
        const rect = image.getBoundingClientRect();
        const naturalRatio = image.naturalWidth / image.naturalHeight;
        const renderedRatio = rect.width / rect.height;
        return {
          src: image.getAttribute("src"),
          natural: `${image.naturalWidth}x${image.naturalHeight}`,
          rendered: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
          ratioDelta: Math.abs(renderedRatio - naturalRatio) / naturalRatio
        };
      })
      .filter((image) => !Number.isFinite(image.ratioDelta) || image.ratioDelta > 0.02);
    const downloadLinks = [...document.querySelectorAll("a[href]")]
      .filter((link) => link.getAttribute("href")?.includes(expectedInstallerName))
      .map((link) => link.href);
    const heroImage = document.querySelector(".hero__shot img");
    const contentImages = [...document.querySelectorAll("main img")];
    const authoredLoading = (image) => (window.authoredLoading?.has(image) ? window.authoredLoading.get(image) : image.getAttribute("loading"));
    return {
      title: document.title,
      h1: document.querySelector("h1")?.textContent.replace(/\s+/g, " ").trim() || "",
      sectionCount: document.querySelectorAll("main section").length,
      sectionIds: [...document.querySelectorAll("main > section[id]")].map((section) => section.id),
      unsizedImages: [...document.images].filter((image) => !image.getAttribute("width") || !image.getAttribute("height")).map((image) => image.getAttribute("src")),
      heroImage: heroImage
        ? { src: heroImage.getAttribute("src"), fetchpriority: heroImage.getAttribute("fetchpriority"), loading: authoredLoading(heroImage) }
        : null,
      eagerBelowFold: contentImages.filter((image) => image !== heroImage && authoredLoading(image) !== "lazy").map((image) => image.getAttribute("src")),
      externalAssets: [
        ...[...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.getAttribute("href")),
        ...[...document.querySelectorAll("script[src]")].map((script) => script.getAttribute("src"))
      ].filter((href) => /^(https?:)?\/\//.test(href || "")),
      installerSize: document.querySelector("[data-installer-size]")?.textContent.trim() || "",
      releaseVersions: [...document.querySelectorAll("[data-release-version]")].map((element) => element.textContent.trim()),
      downloadButtonText: [...document.querySelectorAll("a[href]")]
        .find((link) => link.getAttribute("href")?.includes(expectedInstallerName))?.textContent.replace(/\s+/g, " ").trim() || "",
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth,
      offenders,
      images,
      aspectIssues,
      downloadLinks,
      guidedDownloadLinks: document.querySelectorAll('a[href="#download"]').length,
      checksumFileLinks: [...document.querySelectorAll('a[href*="SHA256SUMS.txt"]')].map((link) => link.href),
      relativeParentLinks: [...document.querySelectorAll('a[href^=".."]')].map((link) => link.getAttribute("href")),
      checksum: document.querySelector("[data-checksum]")?.textContent.trim() || "",
      verifyCommand: document.querySelector("[data-verify-command]")?.textContent.trim() || "",
      unsignedDisclosure: document.querySelector("#unsigned-preview-note")?.textContent.replace(/\s+/g, " ").trim() || "",
      brandMarks: document.querySelectorAll('.brand img[src$="assets/brand-mark.svg"]').length,
      svgFavicon: document.querySelector('link[rel="icon"][type="image/svg+xml"]')?.getAttribute("href") || "",
      majorFeatures: ["demo", "features", "ai"].map((id) => ({
        id,
        present: Boolean(document.getElementById(id)),
        media: Boolean(document.querySelector(`#${id} img[src^="assets/"], #${id} video`))
      }))
    };
  }, installerName);
}

async function releaseExpectations() {
  // The site describes the latest published release, which trails package.json
  // until that release exists, so site/release.json is the reference version.
  const release = JSON.parse(await fs.readFile(path.join(siteRoot, "release.json"), "utf8"));
  const version = String(release.version || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`site/release.json has an invalid version: ${release.version || "missing"}.`);
  }
  return {
    version,
    installerName: String(release.installer || ""),
    checksum: String(release.sha256 || ""),
    sizeMiB: release.sizeMiB
  };
}

function markdownReport(report) {
  const lines = [
    "# Landing Page Smoke",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.fail} fail.`,
    "",
    "| Status | Check | Detail |",
    "| --- | --- | --- |"
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.status.toUpperCase()} | ${check.id} | ${String(check.detail).replaceAll("|", "\\|")} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const evidence = [];
  const errors = [];
  const release = await releaseExpectations();
  for (const archive of [
    { file: "legacy-2026-07-15.html", label: "15 July 2026" },
    { file: "legacy-2026-07-17.html", label: "17 July 2026" }
  ]) {
    const legacyHomepage = await fs.readFile(path.join(siteRoot, archive.file), "utf8");
    addCheck(
      checks,
      `legacy-homepage-archive-${archive.label.slice(0, 2)}`,
      legacyHomepage.includes(`Archived homepage from ${archive.label}`) &&
        legacyHomepage.includes('content="noindex,nofollow"'),
      `${archive.label} homepage is preserved with an archive notice and excluded from indexing`
    );
  }
  const archiveFiles = (await fs.readdir(siteRoot)).filter((name) => /^legacy-.+\.html$/.test(name));
  const archiveTitles = new Map();
  const archiveProblems = [];
  for (const file of archiveFiles) {
    const html = await fs.readFile(path.join(siteRoot, file), "utf8");
    const url = `https://terrorproforma.github.io/explore-better/${file}`;
    const title = /<title>([^<]+)<\/title>/.exec(html)?.[1] || "";
    if (archiveTitles.has(title)) archiveProblems.push(`${file} duplicates the title of ${archiveTitles.get(title)}`);
    archiveTitles.set(title, file);
    if (!html.includes('content="noindex,nofollow"')) archiveProblems.push(`${file} is indexable`);
    if (!html.includes(`<link rel="canonical" href="${url}" />`)) archiveProblems.push(`${file} canonical is not self`);
    if (!html.includes(`<meta property="og:url" content="${url}" />`)) archiveProblems.push(`${file} og:url is not self`);
    if (html.includes("application/ld+json")) archiveProblems.push(`${file} repeats the live structured data`);
  }
  addCheck(checks, "legacy-homepage-archive-metadata", archiveProblems.length === 0,
    archiveProblems.join("; ") || `${archiveFiles.length} archives have unique titles, self URLs, and no structured data`);
  const homepageSource = await fs.readFile(path.join(siteRoot, "index.html"), "utf8");
  const footerArchives = [...homepageSource.matchAll(/<a href="(legacy-[^"]+\.html)">(Previous|Original) Homepage<\/a>/g)].map((match) => match[1]);
  addCheck(checks, "legacy-homepage-footer-links",
    footerArchives.length === 2 && footerArchives.every((file) => archiveFiles.includes(file)),
    footerArchives.join(", ") || "Missing archive footer links");
  const { server, baseUrl } = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: browserPath(), headless: true });
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
      const page = await context.newPage();
      await page.addInitScript(() => {
        window.copyFixture = { mode: "modern", writes: [], commands: [] };
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
          async writeText(value) {
            window.copyFixture.writes.push(value);
            if (window.copyFixture.mode !== "modern") throw new Error("Fixture clipboard unavailable");
          }
        } });
        document.execCommand = (command) => {
          window.copyFixture.commands.push(command);
          if (window.copyFixture.mode === "fallback-throws") throw new Error("Fixture copy rejected");
          return window.copyFixture.mode === "fallback-success";
        };
      });
      page.on("pageerror", (error) => errors.push(`${viewport.name}: ${error.message}`));
      const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
      await page.waitForSelector("h1");
      await page.evaluate(async () => {
        const images = [...document.images];
        // Remember the authored loading attributes before forcing every image to load.
        window.authoredLoading = new WeakMap(images.map((image) => [image, image.getAttribute("loading")]));
        images.forEach((image) => {
          image.loading = "eager";
        });
        await Promise.all(
          images.map((image) => {
            if (image.complete) return Promise.resolve();
            return new Promise((resolve) => {
              image.addEventListener("load", resolve, { once: true });
              image.addEventListener("error", resolve, { once: true });
            });
          })
        );
      });

      addCheck(checks, `${viewport.name}-response`, response?.ok() === true, `HTTP ${response?.status() || 0}`);

      const snapshot = await pageSnapshot(page, release.installerName);
      addCheck(checks, `${viewport.name}-title`, snapshot.title.includes("Explore Better"), snapshot.title);
      addCheck(checks, `${viewport.name}-hero`, snapshot.h1 === expectedHeadline, snapshot.h1 || "Missing H1");
      addCheck(
        checks,
        `${viewport.name}-brand-system`,
        snapshot.brandMarks >= 2 && snapshot.svgFavicon === "assets/brand-mark.svg",
        `${snapshot.brandMarks} brand marks; favicon ${snapshot.svgFavicon || "missing"}`
      );
      addCheck(
        checks,
        `${viewport.name}-sections`,
        snapshot.sectionCount >= requiredSections.length && requiredSections.every((id) => snapshot.sectionIds.includes(id)),
        `${snapshot.sectionCount} main sections; missing: ${requiredSections.filter((id) => !snapshot.sectionIds.includes(id)).join(", ") || "none"}`
      );
      addCheck(
        checks,
        `${viewport.name}-image-dimensions`,
        snapshot.unsizedImages.length === 0,
        snapshot.unsizedImages.join(", ") || "Every image declares width and height (no layout shift)"
      );
      addCheck(
        checks,
        `${viewport.name}-image-loading`,
        snapshot.heroImage?.fetchpriority === "high" && snapshot.heroImage?.loading !== "lazy" &&
          /\.webp$/.test(snapshot.heroImage?.src || "") && snapshot.eagerBelowFold.length === 0,
        snapshot.eagerBelowFold.length
          ? `Not lazy: ${snapshot.eagerBelowFold.join(", ")}`
          : `Hero ${snapshot.heroImage?.src || "missing"} is eager with high priority; every other image is lazy`
      );
      addCheck(checks, `${viewport.name}-local-assets`, snapshot.externalAssets.length === 0, snapshot.externalAssets.join(", ") || "No external stylesheets or scripts");
      addCheck(
        checks,
        `${viewport.name}-release-strings`,
        snapshot.installerSize === `${release.sizeMiB} MiB` &&
          snapshot.releaseVersions.length >= 2 && snapshot.releaseVersions.every((value) => value === `v${release.version}`) &&
          snapshot.downloadButtonText === `Download Explore Better v${release.version}`,
        `${snapshot.installerSize}; ${snapshot.releaseVersions.join(", ")}; "${snapshot.downloadButtonText}"`
      );
      addCheck(
        checks,
        `${viewport.name}-major-features`,
        snapshot.majorFeatures.every((feature) => feature.present && feature.media),
        snapshot.majorFeatures.map((feature) => `${feature.id}: ${feature.media ? "media present" : "missing"}`).join(", ")
      );
      addCheck(
        checks,
        `${viewport.name}-no-horizontal-overflow`,
        snapshot.scrollWidth <= snapshot.viewportWidth + 1,
        snapshot.scrollWidth > snapshot.viewportWidth + 1
          ? JSON.stringify(snapshot.offenders)
          : `${snapshot.scrollWidth}/${snapshot.viewportWidth}px`
      );
      const badImages = snapshot.images.filter((image) => !image.complete || image.naturalWidth < 1);
      addCheck(
        checks,
        `${viewport.name}-images`,
        badImages.length === 0,
        badImages.length ? JSON.stringify(badImages) : `${snapshot.images.length} images loaded`
      );
      addCheck(
        checks,
        `${viewport.name}-image-aspect-ratios`,
        snapshot.aspectIssues.length === 0,
        snapshot.aspectIssues.length
          ? JSON.stringify(snapshot.aspectIssues)
          : "All content screenshots preserve their natural aspect ratio"
      );
      addCheck(
        checks,
        `${viewport.name}-downloads`,
        snapshot.downloadLinks.length === 1 && snapshot.downloadLinks.every((href) => href.startsWith("https://github.com/")),
        `${snapshot.downloadLinks.length} direct installer link after disclosure`
      );
      addCheck(
        checks,
        `${viewport.name}-guided-downloads`,
        snapshot.guidedDownloadLinks >= 2,
        `${snapshot.guidedDownloadLinks} prominent links route through the verification panel`
      );
      addCheck(
        checks,
        `${viewport.name}-checksum-file`,
        snapshot.checksumFileLinks.length === 1 && snapshot.checksumFileLinks[0].startsWith("https://github.com/"),
        snapshot.checksumFileLinks.join(", ") || "Missing SHA256SUMS.txt link"
      );
      addCheck(
        checks,
        `${viewport.name}-published-links`,
        snapshot.relativeParentLinks.length === 0,
        snapshot.relativeParentLinks.length ? snapshot.relativeParentLinks.join(", ") : "No parent-relative links"
      );
      addCheck(
        checks,
        `${viewport.name}-checksum`,
        release.checksum ? snapshot.checksum === release.checksum : /^[a-f0-9]{64}$/i.test(snapshot.checksum),
        snapshot.checksum
      );
      addCheck(
        checks,
        `${viewport.name}-verify-command`,
        snapshot.verifyCommand === `Get-FileHash .\\${release.installerName} -Algorithm SHA256`,
        snapshot.verifyCommand
      );
      addCheck(
        checks,
        `${viewport.name}-unsigned-disclosure`,
        snapshot.unsignedDisclosure.includes("Unsigned public preview") && snapshot.unsignedDisclosure.includes("Unknown publisher"),
        snapshot.unsignedDisclosure || "Missing unsigned preview disclosure"
      );

      await page.locator('[data-copy-target="[data-verify-command]"]').click();
      await page.waitForFunction(
        () => document.querySelector("[data-command-copy-status]")?.textContent?.trim() === "Command copied",
        null,
        { timeout: 5_000 }
      );
      const commandCopyStatus = (await page.locator("[data-command-copy-status]").textContent())?.trim() || "";
      addCheck(
        checks,
        `${viewport.name}-copy-command`,
        commandCopyStatus === "Command copied",
        commandCopyStatus || "Missing copy status"
      );
      for (const mode of ["modern", "fallback-success", "fallback-false", "fallback-throws"]) {
        await page.evaluate((value) => {
          window.copyFixture.mode = value;
          window.copyFixture.writes = [];
          window.copyFixture.commands = [];
          document.querySelector("[data-command-copy-status]").textContent = "";
        }, mode);
        await page.locator('[data-copy-target="[data-verify-command]"]').click();
        const copy = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve({
          status: document.querySelector("[data-command-copy-status]").textContent.trim(),
          focused: document.activeElement.matches('[data-copy-target="[data-verify-command]"]'),
          textareas: document.querySelectorAll("textarea").length,
          ...window.copyFixture
        }))));
        const success = ["modern", "fallback-success"].includes(mode);
        addCheck(checks, `${viewport.name}-copy-${mode}`,
          copy.status === (success ? "Command copied" : "Could not copy. Select and copy the text manually.") &&
            copy.focused && copy.textareas === 0 && copy.writes[0] === snapshot.verifyCommand &&
            copy.commands.length === (mode === "modern" ? 0 : 1),
          JSON.stringify(copy));
      }

      // Demo chapters are rendered from the VideoObject hasPart clips in the JSON-LD.
      const chapterState = await page.evaluate(() => {
        const graph = [...document.querySelectorAll('script[type="application/ld+json"]')]
          .flatMap((script) => JSON.parse(script.textContent)["@graph"] || []);
        const clips = graph.find((node) => node["@type"] === "VideoObject")?.hasPart || [];
        const buttons = [...document.querySelectorAll("[data-chapter-list] button[data-demo-time]")];
        return {
          clips: clips.map((clip) => `${clip.startOffset}:${clip.name}`),
          buttons: buttons.map((button) => `${button.dataset.demoTime}:${button.lastElementChild?.textContent.trim()}`),
          visible: !document.querySelector("[data-chapters]")?.hidden,
          current: buttons.filter((button) => button.getAttribute("aria-current") === "true").length
        };
      });
      addCheck(
        checks,
        `${viewport.name}-demo-chapter-list`,
        chapterState.visible && chapterState.clips.length >= 3 && chapterState.buttons.join("|") === chapterState.clips.join("|") && chapterState.current === 1,
        `${chapterState.buttons.length} chapter buttons match ${chapterState.clips.length} JSON-LD clips; ${chapterState.current} current`
      );
      const lastClipStart = chapterState.clips.at(-2)?.split(":")[0] || "0";
      const codexChapter = page.locator(`[data-chapter-list] [data-demo-time="${lastClipStart}"]`);
      await page.locator("[data-demo-video]").evaluate((video) => {
        video.pause();
        video.play = () => Promise.resolve();
      });
      await codexChapter.click();
      const seeked = await page
        .waitForFunction((start) => Math.abs(document.querySelector("[data-demo-video]").currentTime - Number(start)) < 0.5, lastClipStart, { timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      addCheck(
        checks,
        `${viewport.name}-demo-chapters`,
        (await codexChapter.getAttribute("aria-current")) === "true" && seeked &&
          (await page.locator('[data-chapter-list] [aria-current="true"]').count()) === 1,
        `Chapter at ${lastClipStart}s becomes current and seeks the video (${seeked ? "seeked" : "did not seek"})`
      );

      // Tool catalogue filter: pure CSS (:has), so it also works without JavaScript.
      const toolCounts = {};
      for (const filter of ["default", "write", "all"]) {
        await page.locator(`[data-tool-filter="${filter}"]`).check({ force: true });
        toolCounts[filter] = await page.evaluate(() => ({
          tools: [...document.querySelectorAll("[data-tools] li[data-access]")].filter((item) => item.getBoundingClientRect().height > 0).length,
          groups: [...document.querySelectorAll("[data-tools] .tools__group")].filter((group) => group.getBoundingClientRect().height > 0).length
        }));
      }
      addCheck(
        checks,
        `${viewport.name}-tool-filter`,
        toolCounts.all.tools === 32 && toolCounts.default.tools === 21 && toolCounts.write.tools === 11 &&
          toolCounts.all.groups === 5 && toolCounts.write.groups === 2,
        JSON.stringify(toolCounts)
      );

      // FAQ: native disclosure widgets that mirror the FAQPage structured data.
      const faq = await page.evaluate(() => {
        const graph = [...document.querySelectorAll('script[type="application/ld+json"]')]
          .flatMap((script) => JSON.parse(script.textContent)["@graph"] || []);
        const questions = (graph.find((node) => node["@type"] === "FAQPage")?.mainEntity || []).map((question) => question.name);
        const summaries = [...document.querySelectorAll("#faq summary")].map((summary) => summary.textContent.trim());
        return { questions, summaries };
      });
      const firstQuestion = page.locator("#faq details").first();
      await firstQuestion.locator("summary").click();
      const opened = await firstQuestion.evaluate((details) => details.open && details.querySelector("p").getBoundingClientRect().height > 0);
      addCheck(
        checks,
        `${viewport.name}-faq`,
        faq.summaries.length >= 5 && faq.summaries.join("|") === faq.questions.join("|") && opened,
        `${faq.summaries.length} questions match FAQPage JSON-LD; first answer ${opened ? "opens" : "did not open"}`
      );

      // Benchmark bars are sized from the published numbers.
      const bars = await page.evaluate(() => [...document.querySelectorAll("[data-benchmark-row]")].map((row) => {
        const [mcp, powershell] = [...row.querySelectorAll(".bar")].map((bar) => bar.getBoundingClientRect().width);
        return { mcp, powershell };
      }));
      addCheck(
        checks,
        `${viewport.name}-benchmark-bars`,
        bars.length === 3 && bars.every((bar) => bar.powershell > bar.mcp && bar.mcp >= 2),
        JSON.stringify(bars)
      );

      // Skip link is the first focus stop and becomes visible.
      await page.goto(baseUrl, { waitUntil: "load" });
      await page.bringToFront();
      await page.keyboard.press("Tab");
      await page.waitForTimeout(100);
      const skip = await page.evaluate(() => {
        const element = document.activeElement;
        const rect = element.getBoundingClientRect();
        return {
          isSkip: element.matches(".skip-link"),
          visible: rect.top >= 0 && rect.bottom <= window.innerHeight,
          outline: getComputedStyle(element).outlineStyle,
          target: Boolean(document.querySelector(element.getAttribute("href") || "#missing"))
        };
      });
      addCheck(checks, `${viewport.name}-skip-link`, skip.isSkip && skip.visible && skip.target && skip.outline !== "none", JSON.stringify(skip));

      if (viewport.name === "mobile") {
        const toggle = page.locator("[data-nav-toggle]");
        addCheck(checks, "mobile-nav-collapsed", (await toggle.getAttribute("aria-expanded")) === "false", "Starts collapsed");
        await toggle.click();
        addCheck(
          checks,
          "mobile-nav-opens",
          (await toggle.getAttribute("aria-expanded")) === "true" && (await page.locator("[data-nav]").isVisible()),
          "Menu opens and updates accessibility state"
        );
        await page.keyboard.press("Escape");
        addCheck(checks, "mobile-nav-escape", (await toggle.getAttribute("aria-expanded")) === "false", "Escape closes menu");
        addCheck(
          checks,
          "mobile-nav-escape-focus",
          await toggle.evaluate((element) => document.activeElement === element),
          "Escape returns focus to the menu toggle"
        );
        await toggle.click();
        await page.setViewportSize({ width: 1100, height: viewport.height });
        await page.waitForFunction(() => !document.body.classList.contains("nav-open"), null, { timeout: 5_000 }).catch(() => {});
        const widened = await page.evaluate(() => ({
          navOpen: document.body.classList.contains("nav-open"),
          expanded: document.querySelector("[data-nav-toggle]").getAttribute("aria-expanded"),
          overflow: getComputedStyle(document.body).overflow
        }));
        addCheck(
          checks,
          "mobile-nav-closes-on-widen",
          !widened.navOpen && widened.expanded === "false" && widened.overflow !== "hidden",
          JSON.stringify(widened)
        );
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
      }

      const screenshot = path.join(artifactsDir, `landing-page-${viewport.name}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      evidence.push({ viewport, screenshot, snapshot });
      await context.close();
    }

    // Without JavaScript every section, the recorded trace, the download panel and the tool
    // filter still work; only the JS-built chapter list stays hidden.
    const noScriptContext = await browser.newContext({ viewport: viewports[0], javaScriptEnabled: false });
    const noScriptPage = await noScriptContext.newPage();
    await noScriptPage.goto(baseUrl, { waitUntil: "load" });
    const noScript = await noScriptPage.evaluate(() => {
      const hidden = (element) => {
        const style = getComputedStyle(element);
        return style.opacity !== "1" || style.visibility === "hidden" || style.display === "none";
      };
      return {
        hiddenSections: [...document.querySelectorAll("main > section")].filter(hidden).map((section) => section.id),
        hiddenTrace: [...document.querySelectorAll(".trace__log > li")].filter(hidden).length,
        traceItems: document.querySelectorAll(".trace__log > li").length,
        chaptersHidden: document.querySelector("[data-chapters]")?.hidden === true,
        downloadVisible: !hidden(document.querySelector("#download a[href*='releases/download']"))
      };
    });
    await noScriptPage.locator('[data-tool-filter="write"]').check({ force: true });
    const noScriptWriteTools = await noScriptPage.evaluate(
      () => [...document.querySelectorAll("[data-tools] li[data-access]")].filter((item) => item.getBoundingClientRect().height > 0).length
    );
    addCheck(
      checks,
      "no-js-content-visible",
      noScript.hiddenSections.length === 0 && noScript.hiddenTrace === 0 && noScript.traceItems >= 5 && noScript.chaptersHidden && noScript.downloadVisible,
      `${noScript.hiddenSections.length} hidden sections, ${noScript.hiddenTrace}/${noScript.traceItems} hidden trace items, chapters ${noScript.chaptersHidden ? "hidden" : "shown empty"}`
    );
    addCheck(checks, "no-js-tool-filter", noScriptWriteTools === 11, `${noScriptWriteTools} tools shown for "Change files" without JavaScript`);
    await noScriptContext.close();

    // The hero trace is the page's one orchestrated animation; reduced motion must skip it.
    const motionState = async (reducedMotion) => {
      const context = await browser.newContext({ viewport: viewports[0], reducedMotion });
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.documentElement.classList.contains("js"));
      const state = await page.evaluate(() => [...document.querySelectorAll(".trace__log > li")].map((item) => ({
        animation: getComputedStyle(item).animationName,
        duration: Number.parseFloat(getComputedStyle(item).animationDuration) || 0
      })));
      await context.close();
      return state;
    };
    const animated = await motionState("no-preference");
    const reduced = await motionState("reduce");
    addCheck(
      checks,
      "reduced-motion",
      animated.length >= 5 && animated.every((item) => item.animation === "trace-in" && item.duration > 0.1) &&
        reduced.every((item) => item.animation === "none" || item.duration < 0.01),
      `animated: ${animated.map((item) => item.animation).join(",")}; reduced: ${reduced.map((item) => `${item.animation}/${item.duration}s`).join(",")}`
    );

    // Clip URLs in the VideoObject use #t=<seconds>; arriving on one seeks the demo.
    const deepContext = await browser.newContext({ viewport: viewports[0], reducedMotion: "reduce" });
    const deepPage = await deepContext.newPage();
    // Use a mid-video chapter from the page's own VideoObject so recuts stay covered.
    const clipStarts = [...homepageSource.matchAll(/"@type":\s*"Clip"[^}]*?"startOffset":\s*([\d.]+)/g)].map((match) => match[1]);
    if (clipStarts.length <= 2) throw new Error("The VideoObject should list chapter clips for the deep-link check.");
    const deepStart = clipStarts[Math.floor(clipStarts.length / 2)] || "0";
    await deepPage.goto(`${baseUrl}/#t=${deepStart}`, { waitUntil: "load" });
    const deepLinked = await deepPage
      .waitForFunction((start) => {
        const video = document.querySelector("[data-demo-video]");
        const current = document.querySelector('[data-chapter-list] [aria-current="true"]');
        return Math.abs(video.currentTime - Number(start)) < 0.5 && current?.dataset.demoTime === start;
      }, deepStart, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    addCheck(checks, "demo-deep-link", deepLinked, deepLinked ? `#t=${deepStart} seeks the demo and marks its chapter current` : `Deep link #t=${deepStart} did not seek the demo`);
    await deepContext.close();

    addCheck(checks, "runtime-errors", errors.length === 0, errors.length ? errors.join("; ") : "No page errors");
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      pass: checks.filter((check) => check.status === "pass").length,
      fail: checks.filter((check) => check.status === "fail").length
    },
    checks,
    evidence,
    errors
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, markdownReport(report), "utf8");
  console.log(`landing page smoke: ${report.summary.pass} pass, ${report.summary.fail} fail`);
  console.log(`wrote ${reportPath}`);
  console.log(`wrote ${markdownPath}`);
  if (report.summary.fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
