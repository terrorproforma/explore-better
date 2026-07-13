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
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

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
      response.writeHead(200, {
        "content-type": mimeTypes[path.extname(target).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store"
      });
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

async function pageSnapshot(page) {
  return page.evaluate(() => {
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
      .filter((image) => image.naturalWidth >= 300 && !image.classList.contains("hero__media"))
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
    const downloadLinks = [...document.querySelectorAll('a[href*="ExploreBetter-0.1.2-x64-setup.exe"]')].map(
      (link) => link.href
    );
    return {
      title: document.title,
      h1: document.querySelector("h1")?.textContent.trim() || "",
      sectionCount: document.querySelectorAll("main section").length,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth,
      offenders,
      images,
      aspectIssues,
      downloadLinks,
      relativeParentLinks: [...document.querySelectorAll('a[href^=".."]')].map((link) => link.getAttribute("href")),
      checksum: document.querySelector("[data-checksum]")?.textContent.trim() || ""
    };
  });
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
  const { server, baseUrl } = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: browserPath(), headless: true });
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`${viewport.name}: ${error.message}`));
      const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
      await page.waitForSelector("h1");
      await page.evaluate(async () => {
        const images = [...document.images];
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

      const snapshot = await pageSnapshot(page);
      addCheck(checks, `${viewport.name}-title`, snapshot.title.includes("Explore Better"), snapshot.title);
      addCheck(checks, `${viewport.name}-hero`, snapshot.h1 === "Explore Better", snapshot.h1 || "Missing H1");
      addCheck(checks, `${viewport.name}-sections`, snapshot.sectionCount >= 8, `${snapshot.sectionCount} main sections`);
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
        snapshot.downloadLinks.length >= 3 && snapshot.downloadLinks.every((href) => href.startsWith("https://github.com/")),
        `${snapshot.downloadLinks.length} direct installer links`
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
        snapshot.checksum === "2851cc5ab923a9a1bae9f5ee860c2be07d54b3fcd21812b50e99cc6d6d27d0a0",
        snapshot.checksum
      );

      await page.locator('[data-tour-tab][data-label="Disk Map"]').click();
      addCheck(
        checks,
        `${viewport.name}-gallery`,
        (await page.locator("[data-tour-image]").getAttribute("src")) === "assets/disk-map.png" &&
          (await page.locator("[data-tour-label]").textContent())?.trim() === "Disk Map",
        "Disk Map tab updates the product stage"
      );

      const tourAspectResults = [];
      for (const label of ["Dual panes", "Disk Map", "Command Center", "Integration"]) {
        await page.locator(`[data-tour-tab][data-label="${label}"]`).click();
        const ratio = await page.locator("[data-tour-image]").evaluate(async (image) => {
          if (!image.complete) {
            await new Promise((resolve) => {
              image.addEventListener("load", resolve, { once: true });
              image.addEventListener("error", resolve, { once: true });
            });
          }
          const rect = image.getBoundingClientRect();
          const naturalRatio = image.naturalWidth / image.naturalHeight;
          const renderedRatio = rect.width / rect.height;
          return {
            src: image.getAttribute("src"),
            natural: `${image.naturalWidth}x${image.naturalHeight}`,
            rendered: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
            ratioDelta: Math.abs(renderedRatio - naturalRatio) / naturalRatio
          };
        });
        tourAspectResults.push({ label, ...ratio });
      }
      const distortedTourImages = tourAspectResults.filter(
        (image) => !Number.isFinite(image.ratioDelta) || image.ratioDelta > 0.02
      );
      addCheck(
        checks,
        `${viewport.name}-tour-image-aspect-ratios`,
        distortedTourImages.length === 0,
        distortedTourImages.length
          ? JSON.stringify(distortedTourImages)
          : tourAspectResults.map((image) => `${image.label}: ${image.rendered}`).join(", ")
      );

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
      }

      const screenshot = path.join(artifactsDir, `landing-page-${viewport.name}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      evidence.push({ viewport, screenshot, snapshot });
      await context.close();
    }

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
