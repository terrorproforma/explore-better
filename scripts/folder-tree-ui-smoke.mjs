import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const root = process.cwd();
const artifacts = path.join(root, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifacts, `folder-tree-ui-${stamp}`);
const fixture = path.join(runRoot, "Tree Fixture");
const errorTarget = path.join(fixture, "Error Target");
const appData = path.join(runRoot, "appdata");
const outputJson = path.join(artifacts, "folder-tree-ui-latest.json");
const outputMarkdown = path.join(artifacts, "folder-tree-ui-latest.md");
const screenshotPath = path.join(artifacts, "folder-tree-ui-latest.png");

function addCheck(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

function normalize(value) {
  return path.resolve(String(value || "")).toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForServer(baseUrl, child, output) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (child.exitCode !== null) throw new Error(`Server exited early with ${child.exitCode}: ${output()}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Folder Tree test server did not become ready: ${output()}`);
}

function treeNode(page, name) {
  const label = page.locator("#folder-tree .tree-name", { hasText: new RegExp(`^${escapeRegExp(name)}$`) }).first();
  return label.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' tree-node ')][1]");
}

async function latestTreeContext(page) {
  return page.evaluate(() => window.__folderTreeContexts.at(-1)?.ui?.navigator?.folderTree || null);
}

const desktopMock = `(() => {
  window.__folderTreeContexts = [];
  window.exploreBetterDesktop = {
    aiBridge: {
      publishContext(context) {
        window.__folderTreeContexts.push(JSON.parse(JSON.stringify(context)));
        while (window.__folderTreeContexts.length > 100) window.__folderTreeContexts.shift();
        return true;
      },
      onAction() { return () => {}; }
    }
  };
})();`;

async function main() {
  await fs.mkdir(errorTarget, { recursive: true });
  await fs.mkdir(path.join(errorTarget, "Recovered"), { recursive: true });
  await fs.mkdir(path.join(fixture, "Folder 1", "Nested"), { recursive: true });
  for (let index = 2; index <= 84; index += 1) {
    await fs.mkdir(path.join(fixture, `Folder ${index}`), { recursive: true });
  }
  await fs.mkdir(appData, { recursive: true });

  const port = Number(process.env.PORT || 50_000 + Math.floor(Math.random() * 10_000));
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const pageErrors = [];
  const consoleErrors = [];
  const expectedConsoleErrors = [];
  let serverOutput = "";
  let rootTreeCalls = 0;
  let errorTreeCalls = 0;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  server.stdout.on("data", (chunk) => (serverOutput += chunk));
  server.stderr.on("data", (chunk) => (serverOutput += chunk));

  let browser = null;
  try {
    await waitForServer(baseUrl, server, () => serverOutput);
    browser = await chromium.launch({
      executablePath: process.env.EB_FOLDER_TREE_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      if (/Failed to load resource: the server responded with a status of 500/i.test(message.text())) {
        expectedConsoleErrors.push(message.text());
      } else {
        consoleErrors.push(message.text());
      }
    });
    await page.addInitScript({ content: desktopMock });
    await page.route("**/api/roots", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.shortcuts = [{ id: "tree-fixture", name: "Tree Fixture", path: fixture, kind: "folder" }];
      data.drives = [];
      await route.fulfill({ response, json: data });
    });
    await page.route("**/api/tree?*", async (route) => {
      const requested = new URL(route.request().url()).searchParams.get("path");
      if (normalize(requested) === normalize(fixture)) {
        rootTreeCalls += 1;
        if (rootTreeCalls === 1) await new Promise((resolve) => setTimeout(resolve, 220));
      }
      if (normalize(requested) === normalize(errorTarget)) {
        errorTreeCalls += 1;
        if (errorTreeCalls === 1) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: `ENOENT: no such file or directory, scandir '${errorTarget}'` })
          });
          return;
        }
      }
      await route.continue();
    });

    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__exploreBetterStartup?.completedAt));
    await page.evaluate(() => document.querySelector('#default-explorer-dialog[open] [data-default-explorer-choice="keep"]')?.click());
    await page.waitForSelector('#folder-tree .tree-name:text-is("Tree Fixture")');

    const header = await page.locator("#folder-tree-title").innerText();
    addCheck(checks, "plain-refresh-label", /Reveal/.test(header) && /Refresh/.test(header) && !/\bR\b/.test(header), header.replace(/\s+/g, " ").trim());

    const rootNode = treeNode(page, "Tree Fixture");
    const rootToggle = rootNode.locator(":scope > .tree-row > .tree-toggle");
    const loadStarted = performance.now();
    await rootToggle.click();
    const loading = await rootNode.locator(":scope > .tree-children > .tree-message").textContent();
    addCheck(checks, "visible-loading-state", loading.trim() === "Loading...", loading.trim());
    await page.waitForFunction(() => document.querySelectorAll("#folder-tree .tree-node").length === 81);
    const loadMs = performance.now() - loadStarted;
    addCheck(checks, "bounded-expand-performance", loadMs < 1500, `${loadMs.toFixed(1)} ms for 80 rendered children`);

    const expanded = await rootToggle.getAttribute("aria-expanded");
    const names = await page.locator("#folder-tree .tree-name").allTextContents();
    const truncatedText = (await rootNode.locator(":scope > .tree-children > .tree-message").last().textContent()).trim();
    addCheck(checks, "accessible-expanded-state", expanded === "true", `aria-expanded=${expanded}`);
    addCheck(checks, "natural-folder-order", names.indexOf("Folder 2") < names.indexOf("Folder 10"), names.slice(0, 14).join(", "));
    addCheck(checks, "bounded-truncation-feedback", truncatedText === "Showing first 80 folders", truncatedText);

    const scroll = await page.evaluate(() => {
      const nav = document.querySelector(".nav-rail");
      const tree = document.getElementById("folder-tree");
      return {
        navOwner: getComputedStyle(nav).overflowY === "auto" && nav.scrollHeight > nav.clientHeight,
        treeOverflow: getComputedStyle(tree).overflowY,
        treeOwnsScroll: tree.scrollHeight > tree.clientHeight + 1 && ["auto", "scroll"].includes(getComputedStyle(tree).overflowY)
      };
    });
    addCheck(checks, "single-navigator-scroll", scroll.navOwner && scroll.treeOverflow === "visible" && !scroll.treeOwnsScroll, JSON.stringify(scroll));

    await page.waitForFunction(() => window.__folderTreeContexts.at(-1)?.ui?.navigator?.folderTree?.truncated === true);
    const mcpExpanded = await latestTreeContext(page);
    addCheck(
      checks,
      "mcp-expansion-observability",
      mcpExpanded.renderedNodes === 81 && mcpExpanded.expandedNodes === 1 && mcpExpanded.loadingNodes === 0 && mcpExpanded.truncated === true,
      JSON.stringify(mcpExpanded)
    );

    const folderOne = treeNode(page, "Folder 1");
    await folderOne.locator(":scope > .tree-row > .tree-toggle").click();
    await page.waitForSelector('#folder-tree .tree-name:text-is("Nested")');
    addCheck(checks, "nested-expansion", await treeNode(page, "Nested").count() === 1, "Folder 1 revealed Nested.");

    const errorNode = treeNode(page, "Error Target");
    await errorNode.locator(":scope > .tree-row > .tree-toggle").click();
    await errorNode.locator(":scope > .tree-children > .tree-error").waitFor();
    const errorText = (await errorNode.locator(":scope > .tree-children > .tree-error").innerText()).replace(/\s+/g, " ").trim();
    addCheck(checks, "plain-error-feedback", errorText === "Folder not found Retry" && !/ENOENT|scandir|no such file/i.test(errorText), errorText);
    await page.waitForFunction(() => window.__folderTreeContexts.at(-1)?.ui?.navigator?.folderTree?.errorCount === 1);
    const mcpError = await latestTreeContext(page);
    addCheck(checks, "mcp-error-observability", mcpError.errorCount === 1 && mcpError.messages.some((message) => message.includes("Folder not found")), JSON.stringify(mcpError));
    await errorNode.locator(":scope > .tree-children [data-tree-retry]").click();
    await page.waitForSelector('#folder-tree .tree-name:text-is("Recovered")');
    addCheck(checks, "inline-error-retry", errorTreeCalls === 2 && (await errorNode.locator(":scope > .tree-children > .tree-error").count()) === 0, `${errorTreeCalls} tree calls; recovered child visible`);
    await page.waitForFunction(() => window.__folderTreeContexts.at(-1)?.ui?.navigator?.folderTree?.errorCount === 0);

    const folderTwo = treeNode(page, "Folder 2");
    await folderTwo.locator(":scope > .tree-row > .tree-toggle").click();
    await page.waitForFunction(() => ![...document.querySelectorAll("#folder-tree .tree-name")].find((element) => element.textContent === "Folder 2")?.closest(".tree-node")?.querySelector(":scope > .tree-row > .tree-toggle"));
    addCheck(checks, "leaf-state-removes-false-toggle", (await folderTwo.locator(":scope > .tree-row > .tree-toggle").count()) === 0, "Empty Folder 2 became a leaf without a misleading expand control.");

    const folderThree = treeNode(page, "Folder 3");
    await folderThree.locator(":scope > .tree-row > .tree-main").click();
    await page.waitForFunction((target) => document.querySelector('[data-path-input="left"]').value.toLowerCase() === target.toLowerCase(), path.join(fixture, "Folder 3"));
    addCheck(checks, "open-in-active-pane", normalize(await page.inputValue('[data-path-input="left"]')) === normalize(path.join(fixture, "Folder 3")), await page.inputValue('[data-path-input="left"]'));

    const folderFour = treeNode(page, "Folder 4");
    await folderFour.locator(":scope > .tree-row > .tree-other").click();
    await page.waitForFunction((target) => document.querySelector('[data-path-input="right"]').value.toLowerCase() === target.toLowerCase(), path.join(fixture, "Folder 4"));
    addCheck(checks, "open-in-other-pane", normalize(await page.inputValue('[data-path-input="right"]')) === normalize(path.join(fixture, "Folder 4")), await page.inputValue('[data-path-input="right"]'));

    await page.screenshot({ path: screenshotPath, fullPage: true });
    addCheck(
      checks,
      "runtime-errors",
      pageErrors.length === 0 && consoleErrors.length === 0 && expectedConsoleErrors.length === 1,
      JSON.stringify({ pageErrors, consoleErrors, expectedConsoleErrors })
    );

    const passed = checks.filter((check) => check.status === "pass").length;
    const report = {
      generatedAt: new Date().toISOString(),
      passed,
      failed: checks.length - passed,
      rootTreeCalls,
      errorTreeCalls,
      loadMs: Number(loadMs.toFixed(1)),
      checks,
      screenshot: screenshotPath
    };
    await fs.writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const markdown = [
      "# Folder Tree UI Verification",
      "",
      `Generated: ${report.generatedAt}`,
      "",
      `Result: ${passed}/${checks.length} checks passed.`,
      `Bounded 80-folder expansion: ${report.loadMs} ms.`,
      "",
      "| Check | Result |",
      "| --- | --- |",
      ...checks.map((check) => `| ${check.id} | ${check.status === "pass" ? "Passed" : `Failed: ${check.detail.replaceAll("|", "\\|")}`} |`),
      ""
    ].join("\n");
    await fs.writeFile(outputMarkdown, markdown, "utf8");
    console.log(`Folder Tree UI smoke: ${passed} pass, ${checks.length - passed} fail`);
    console.log(`wrote ${outputMarkdown}`);
    if (passed !== checks.length) process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    if (server.exitCode === null) {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
  }
}

await main();
