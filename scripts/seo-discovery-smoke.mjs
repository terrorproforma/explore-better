import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const root = process.cwd();
const siteRoot = path.join(root, "site");
const artifactsDir = path.join(root, "artifacts");
const reportPath = path.join(artifactsDir, "seo-discovery-latest.json");
const canonicalRoot = "https://terrorproforma.github.io/explore-better/";
const pages = [
  { name: "home", route: "/", file: "index.html", canonical: canonicalRoot, h1: "Explore Better" },
  { name: "mcp", route: "/mcp/", file: "mcp/index.html", canonical: `${canonicalRoot}mcp/`, h1: "Explore Better MCP Server" }
];
const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 }
];

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
};

function add(checks, id, passed, detail) {
  checks.push({ id, status: passed ? "pass" : "fail", detail });
}

function captureTag(html, pattern) {
  return pattern.exec(html)?.[1]?.trim() || "";
}

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => JSON.parse(match[1]));
}

function graphTypes(blocks) {
  const types = [];
  for (const block of blocks) {
    const values = Array.isArray(block?.["@graph"]) ? block["@graph"] : [block];
    for (const value of values) {
      if (Array.isArray(value?.["@type"])) types.push(...value["@type"]);
      else if (value?.["@type"]) types.push(value["@type"]);
    }
  }
  return types;
}

function browserPath() {
  return process.env.EB_LANDING_PAGE_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
}

async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      const target = path.resolve(siteRoot, `.${pathname}`);
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
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const errors = [];
  const htmlByPage = new Map();

  for (const page of pages) {
    const html = await fs.readFile(path.join(siteRoot, page.file), "utf8");
    htmlByPage.set(page.name, html);
    const canonical = captureTag(html, /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i);
    const description = captureTag(html, /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    const robots = captureTag(html, /<meta\s+name=["']robots["']\s+content=["']([^"']+)["']/i);
    const ogUrl = captureTag(html, /<meta\s+property=["']og:url["']\s+content=["']([^"']+)["']/i);
    const ogImage = captureTag(html, /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
    const llms = captureTag(html, /<link\s+rel=["']alternate["'][^>]+href=["']([^"']*llms\.txt)["']/i);
    let blocks = [];
    let parseError = "";
    try {
      blocks = jsonLdBlocks(html);
    } catch (error) {
      parseError = error.message;
    }
    const types = graphTypes(blocks);
    add(checks, `${page.name}-canonical`, canonical === page.canonical, canonical || "missing");
    add(checks, `${page.name}-description`, description.length >= 100 && description.length <= 220, `${description.length} characters`);
    add(checks, `${page.name}-robots-meta`, robots.includes("index") && robots.includes("max-image-preview:large") && !robots.includes("noindex"), robots || "missing");
    add(checks, `${page.name}-open-graph`, ogUrl === page.canonical && ogImage.startsWith(canonicalRoot), `${ogUrl} | ${ogImage}`);
    add(checks, `${page.name}-llms-link`, llms === `${canonicalRoot}llms.txt`, llms || "missing");
    add(checks, `${page.name}-jsonld-parse`, blocks.length > 0 && !parseError, parseError || `${blocks.length} block(s)`);
    add(checks, `${page.name}-jsonld-software`, types.includes("SoftwareApplication"), types.join(", "));
    add(checks, `${page.name}-honest-schema`, !html.includes('"aggregateRating"') && !html.includes('"review"'), "No invented ratings or reviews");
  }

  const homeTypes = graphTypes(jsonLdBlocks(htmlByPage.get("home")));
  const mcpTypes = graphTypes(jsonLdBlocks(htmlByPage.get("mcp")));
  add(checks, "home-semantic-graph", ["WebSite", "SoftwareApplication", "WebPage"].every((type) => homeTypes.includes(type)), homeTypes.join(", "));
  add(checks, "mcp-semantic-graph", ["SoftwareApplication", "TechArticle", "HowTo"].every((type) => mcpTypes.includes(type)), mcpTypes.join(", "));

  const robotsText = await fs.readFile(path.join(siteRoot, "robots.txt"), "utf8");
  add(checks, "robots-general-access", /User-agent:\s*\*[\s\S]*?Allow:\s*\//i.test(robotsText) && !/^Disallow:\s*\/$/im.test(robotsText), "All public content is crawlable");
  add(checks, "robots-openai-search", /User-agent:\s*OAI-SearchBot[\s\S]*?Allow:\s*\//i.test(robotsText), "OAI-SearchBot explicitly allowed");
  add(checks, "robots-sitemap", robotsText.includes(`${canonicalRoot}sitemap.xml`), `${canonicalRoot}sitemap.xml`);

  const sitemap = await fs.readFile(path.join(siteRoot, "sitemap.xml"), "utf8");
  const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  add(checks, "sitemap-canonical-pages", pages.every((page) => sitemapUrls.includes(page.canonical)), sitemapUrls.join(", "));
  add(checks, "sitemap-absolute-urls", sitemapUrls.length > 0 && sitemapUrls.every((url) => url.startsWith(canonicalRoot)), `${sitemapUrls.length} absolute URL(s)`);

  const llms = await fs.readFile(path.join(siteRoot, "llms.txt"), "utf8");
  const llmsFull = await fs.readFile(path.join(siteRoot, "llms-full.txt"), "utf8");
  const normalizedLlms = llms.replace(/\r\n/g, "\n");
  add(checks, "llms-format", normalizedLlms.startsWith("# Explore Better\n\n>") && normalizedLlms.includes("## MCP Evidence") && normalizedLlms.includes("## Optional"), "H1, summary, evidence, and optional sections present");
  add(checks, "llms-canonical-links", ["mcp/", "mcp-value.json", "llms-full.txt", "contracts-v1.json"].every((value) => llms.includes(value)), "Product, evidence, context, and contract linked");
  add(checks, "llms-full-substance", llmsFull.length >= 7_000 && llmsFull.includes("## Security Model") && llmsFull.includes("## Deliberate Limitations"), `${llmsFull.length} characters with security and limitations`);
  add(checks, "llms-no-overclaim", llmsFull.includes("MCP does not replace the integrated terminal") && llmsFull.includes("official MCP Registry entry is not yet published"), "Terminal and registry limitations disclosed");

  const benchmark = JSON.parse(await fs.readFile(path.join(siteRoot, "benchmarks", "mcp-value.json"), "utf8"));
  add(checks, "benchmark-schema", benchmark.schema === "explore-better.mcp-value.v1", benchmark.schema || "missing");
  add(checks, "benchmark-shared-correctness", benchmark.summary?.workflowsPassed === 3 && benchmark.summary?.workflowsTotal === 3, `${benchmark.summary?.workflowsPassed}/${benchmark.summary?.workflowsTotal}`);
  add(checks, "benchmark-mcp-proofs", benchmark.summary?.mcpSpecificProofsPassed === 6 && benchmark.summary?.mcpSpecificProofsTotal === 6, `${benchmark.summary?.mcpSpecificProofsPassed}/${benchmark.summary?.mcpSpecificProofsTotal}`);
  add(checks, "benchmark-repetitions", benchmark.methodology?.repetitions >= 3 && benchmark.methodology?.limitation?.includes("warm shell"), `${benchmark.methodology?.repetitions} repetitions with comparison caveat`);
  add(checks, "benchmark-page-sync", benchmark.workflows.every((workflow) => htmlByPage.get("mcp").includes(`${workflow.mcp.medianMs} ms`) && htmlByPage.get("mcp").includes(`${workflow.powershell.medianMs} ms`)), "Published medians match machine-readable evidence");

  const { server, baseUrl } = await startServer();
  let browser;
  try {
    for (const endpoint of ["/robots.txt", "/sitemap.xml", "/llms.txt", "/llms-full.txt", "/benchmarks/mcp-value.json"]) {
      const response = await fetch(`${baseUrl}${endpoint}`, { headers: { "user-agent": "OAI-SearchBot/1.0" } });
      add(checks, `crawler-fetch-${endpoint.slice(1).replaceAll("/", "-")}`, response.ok, `HTTP ${response.status}`);
    }

    browser = await chromium.launch({ executablePath: browserPath(), headless: true });
    for (const pageSpec of pages) {
      for (const viewport of viewports) {
        const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(`${pageSpec.name}/${viewport.name}: ${error.message}`));
        const response = await page.goto(`${baseUrl}${pageSpec.route}`, { waitUntil: "networkidle" });
        const snapshot = await page.evaluate(() => ({
          h1: document.querySelector("h1")?.innerText?.replace(/\s+/g, " ").trim() || "",
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          visibleText: document.body.innerText,
          brokenImages: [...document.images].filter((image) => image.complete && image.naturalWidth < 1).map((image) => image.getAttribute("src"))
        }));
        add(checks, `${pageSpec.name}-${viewport.name}-response`, response?.ok() === true, `HTTP ${response?.status() || 0}`);
        add(checks, `${pageSpec.name}-${viewport.name}-h1`, snapshot.h1 === pageSpec.h1, snapshot.h1 || "missing");
        add(checks, `${pageSpec.name}-${viewport.name}-overflow`, snapshot.scrollWidth <= snapshot.clientWidth + 1, `${snapshot.scrollWidth}/${snapshot.clientWidth}px`);
        add(checks, `${pageSpec.name}-${viewport.name}-images`, snapshot.brokenImages.length === 0, snapshot.brokenImages.join(", ") || "All loaded images valid");
        if (pageSpec.name === "mcp") {
          add(checks, `mcp-${viewport.name}-proof-content`, snapshot.visibleText.includes("Yes, this is valuable as MCP.") && snapshot.visibleText.includes("Proved against PowerShell."), "Direct answer and evidence are crawlable text");
        }
        await page.screenshot({ path: path.join(artifactsDir, `seo-${pageSpec.name}-${viewport.name}.png`), fullPage: true });
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }

  add(checks, "browser-errors", errors.length === 0, errors.join("; ") || "No page errors");
  const report = {
    schema: "explore-better.seo-discovery.v1",
    generatedAt: new Date().toISOString(),
    summary: {
      pass: checks.filter((check) => check.status === "pass").length,
      fail: checks.filter((check) => check.status === "fail").length
    },
    checks,
    errors
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`SEO discovery smoke: ${report.summary.pass} pass, ${report.summary.fail} fail.`);
  for (const check of checks.filter((item) => item.status === "fail")) {
    console.error(`FAIL ${check.id}: ${check.detail}`);
  }
  console.log(`Evidence: ${reportPath}`);
  if (report.summary.fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
