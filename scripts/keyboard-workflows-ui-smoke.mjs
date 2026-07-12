import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `keyboard-workflows-ui-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "keyboard-workflows-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "keyboard-workflows-ui-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function edgePath() {
  return (
    optionValue("--browser", process.env.EB_KEYBOARD_WORKFLOWS_BROWSER || "") ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  );
}

async function requestJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}`);
}

async function prepareFixture() {
  await fs.mkdir(path.join(fixture, "folder-target"), { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.writeFile(path.join(fixture, "alpha-notes.txt"), "alpha\n");
  await fs.writeFile(path.join(fixture, "beta-filter-target.txt"), "beta\n");
  await fs.writeFile(path.join(fixture, "gamma-report.md"), "# gamma\n");
  await fs.writeFile(path.join(fixture, "folder-target", "inside.txt"), "inside\n");
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function waitForResult(page, fn, label, timeoutMs = 10000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await page.evaluate(fn);
    if (last?.ok) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

async function pressCommand(page, query) {
  await page.keyboard.press("Control+P");
  await page.waitForSelector("#command-dialog[open]", { timeout: 10000 });
  await page.keyboard.type(query);
  const candidates = await waitForResult(
    page,
    () => {
      const items = [...document.querySelectorAll("#command-results [data-palette-index]")].map((item) => ({
        text: item.textContent.trim().replace(/\s+/g, " "),
        active: item.classList.contains("active")
      }));
      return { ok: items.length > 0, items: items.slice(0, 5), focusedId: document.activeElement?.id || "" };
    },
    `palette candidates for ${query}`
  );
  await page.keyboard.press("Enter");
  return candidates;
}

async function inspectKeyboardLayout(page) {
  return page.evaluate(() => {
    const issues = [];
    const samples = [];
    const selectors = [
      "#command-dialog[open] #command-input",
      "#command-dialog[open] [data-palette-index]",
      '[data-quick-search-panel="left"]:not([hidden]) input',
      '[data-quick-search-panel="left"]:not([hidden]) button',
      '[data-quick-search-panel="left"]:not([hidden]) span'
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        const formControl = element.matches("input, select, textarea");
        const text = (element.innerText || element.textContent || element.value || "").trim().replace(/\s+/g, " ");
        const clipped =
          !formControl && (element.scrollWidth > element.clientWidth + 4 || element.scrollHeight > element.clientHeight + 4);
        const squished = rect.width < 24 || rect.height < 18;
        const sample = {
          selector,
          tag: element.tagName.toLowerCase(),
          text: text.slice(0, 90),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          clipped,
          squished
        };
        samples.push(sample);
        if (clipped || squished) {
          issues.push(sample);
        }
      }
    }
    return { issues, samples };
  });
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Keyboard Workflows UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Results

| Workflow | Result |
| --- | --- |
| Command Palette | ${String(report.commandPalette?.horizontal?.items?.[0]?.text || "n/a").replace(/\|/g, "\\|")} |
| Layout | ${report.layout?.className || "n/a"} |
| Quick Search | ${String(report.quickSearch?.countText || "n/a").replace(/\|/g, "\\|")} |
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 48000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const consoleMessages = [];
  const pageErrors = [];
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  let browser = null;
  let commandPalette = {};
  let layout = null;
  let quickSearch = null;
  let keyboardLayout = null;
  try {
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({ executablePath: edgePath(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        consoleMessages.push({ type: message.type(), text: message.text() });
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, {
      waitUntil: "domcontentloaded"
    });
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    await page.locator('[data-list="left"]').focus();

    commandPalette.horizontal = await pressCommand(page, "horizontal split");
    layout = await waitForResult(
      page,
      () => {
        const workbench = document.querySelector(".workbench");
        return {
          ok: workbench?.classList.contains("layout-horizontal"),
          className: workbench?.className || "",
          status: document.getElementById("status-pill")?.textContent?.trim() || ""
        };
      },
      "horizontal command execution"
    );
    check(
      checks,
      "palette-executes-layout-command",
      layout.className.includes("layout-horizontal"),
      `Workbench class: ${layout.className}; status: ${layout.status}.`
    );
    check(
      checks,
      "palette-result-focus",
      commandPalette.horizontal.focusedId === "command-input",
      `Palette focus id: ${commandPalette.horizontal.focusedId}.`
    );

    commandPalette.quickSearch = await pressCommand(page, "quick search current");
    quickSearch = await waitForResult(
      page,
      () => {
        const panel = document.querySelector('[data-quick-search-panel="left"]');
        const input = document.querySelector('[data-quick-search-input="left"]');
        return {
          ok: panel && !panel.hidden && document.activeElement === input,
          inputFocused: document.activeElement === input,
          hidden: panel?.hidden !== false,
          focusedTag: document.activeElement?.tagName || "",
          countText: document.querySelector('[data-quick-search-count="left"]')?.textContent?.trim() || ""
        };
      },
      "quick search opened"
    );
    check(
      checks,
      "palette-opens-quick-search",
      quickSearch.inputFocused && quickSearch.hidden === false,
      `Quick search focused=${quickSearch.inputFocused}, hidden=${quickSearch.hidden}.`
    );
    await page.keyboard.type("beta");
    quickSearch = await waitForResult(
      page,
      () => {
        const rows = [...document.querySelectorAll('.pane[data-pane="left"] [data-entry-path]')].map((row) => ({
          text: row.textContent.trim().replace(/\s+/g, " "),
          path: row.getAttribute("data-entry-path") || ""
        }));
        const countText = document.querySelector('[data-quick-search-count="left"]')?.textContent?.trim() || "";
        return {
          ok: rows.length === 1 && rows[0]?.text.includes("beta-filter-target.txt") && /1 match/.test(countText),
          rows,
          countText,
          value: document.querySelector('[data-quick-search-input="left"]')?.value || ""
        };
      },
      "quick search filter"
    );
    check(
      checks,
      "quick-search-filters-from-keyboard",
      quickSearch.rows?.length === 1 && quickSearch.rows[0]?.text.includes("beta-filter-target.txt"),
      `Rows=${quickSearch.rows?.length || 0}, count=${quickSearch.countText}, value=${quickSearch.value}.`
    );
    keyboardLayout = await inspectKeyboardLayout(page);
    check(
      checks,
      "keyboard-ui-layout",
      keyboardLayout.issues.length === 0,
      `${keyboardLayout.issues.length} clipped/squished keyboard workflow control(s).`
    );
    await page.keyboard.press("Escape");
    const closed = await waitForResult(
      page,
      () => {
        const panel = document.querySelector('[data-quick-search-panel="left"]');
        return { ok: panel?.hidden === true, hidden: panel?.hidden === true };
      },
      "quick search closed"
    );
    check(checks, "quick-search-escape-closes", closed.hidden === true, `Quick search hidden=${closed.hidden}.`);
    check(checks, "browser-console-clean", pageErrors.length === 0, `${pageErrors.length} page error(s).`);
  } catch (error) {
    check(checks, "smoke-execution", false, error.message);
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }

  const summary = {
    pass: checks.filter((item) => item.status === "pass").length,
    warn: checks.filter((item) => item.status === "warn").length,
    fail: checks.filter((item) => item.status === "fail").length
  };
  const report = {
    generatedAt: new Date().toISOString(),
    status: summary.fail ? "fail" : "pass",
    baseUrl,
    fixture,
    commandPalette,
    layout,
    quickSearch,
    keyboardLayout,
    consoleMessages,
    pageErrors,
    serverOutput: serverOutput.slice(-4000),
    summary,
    checks
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(latestMdPath, markdownReport(report));
  console.log(`keyboard workflows UI smoke: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
