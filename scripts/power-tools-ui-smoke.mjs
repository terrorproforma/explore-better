import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `power-tools-ui-${stamp}`);
const leftFixture = path.join(runRoot, "left");
const rightFixture = path.join(runRoot, "right");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "power-tools-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "power-tools-ui-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function edgePath() {
  return (
    optionValue("--browser", process.env.EB_POWER_TOOLS_BROWSER || "") ||
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

async function writeFileWithMtime(filePath, content, modified) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  await fs.utimes(filePath, modified, modified);
}

async function prepareFixture() {
  const oldDate = new Date("2024-01-01T00:00:00Z");
  const newDate = new Date("2026-01-01T00:00:00Z");
  await fs.mkdir(appData, { recursive: true });
  await fs.mkdir(path.join(leftFixture, "nested"), { recursive: true });
  await fs.mkdir(path.join(rightFixture, "nested"), { recursive: true });

  await writeFileWithMtime(path.join(leftFixture, "same.txt"), "same\n", oldDate);
  await writeFileWithMtime(path.join(rightFixture, "same.txt"), "same\n", oldDate);
  await writeFileWithMtime(path.join(leftFixture, "left-only.txt"), "left only\n", newDate);
  await writeFileWithMtime(path.join(rightFixture, "right-only.txt"), "right only\n", oldDate);
  await writeFileWithMtime(path.join(leftFixture, "update.txt"), "left newer version\n", newDate);
  await writeFileWithMtime(path.join(rightFixture, "update.txt"), "right older version\n", oldDate);
  await writeFileWithMtime(path.join(leftFixture, "duplicate-a.txt"), "duplicate payload\n", oldDate);
  await writeFileWithMtime(path.join(leftFixture, "nested", "duplicate-b.txt"), "duplicate payload\n", oldDate);
  await writeFileWithMtime(path.join(leftFixture, "nested", "flat-target.md"), "# flat target\n", oldDate);
  await writeFileWithMtime(path.join(rightFixture, "nested", "right-nested.txt"), "right nested\n", oldDate);
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function clickUnique(page, selector, label) {
  const locator = page.locator(selector);
  const count = await locator.count();
  if (count !== 1) {
    throw new Error(`${label} expected one match, found ${count}.`);
  }
  await locator.click();
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

async function inspectDialogLayout(page, dialogId) {
  return page.evaluate((id) => {
    const dialog = document.getElementById(id);
    const issues = [];
    const samples = [];
    for (const element of dialog?.querySelectorAll("button, input, select, label, .compare-row, .sync-preview-row") || []) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      const text = (element.innerText || element.textContent || element.value || "").trim().replace(/\s+/g, " ");
      const formControl = element.matches("input, select, textarea");
      const tinyControl = element.matches('input[type="checkbox"], input[type="radio"]');
      const clipped = !formControl && (element.scrollWidth > element.clientWidth + 4 || element.scrollHeight > element.clientHeight + 4);
      const squished = tinyControl ? rect.width < 14 || rect.height < 14 : rect.width < 24 || rect.height < 18;
      const sample = {
        tag: element.tagName.toLowerCase(),
        text: text.slice(0, 80),
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
    return { dialogId: id, issues, samples };
  }, dialogId);
}

async function runFlat(page, checks) {
  await clickUnique(page, '[data-global-action="flat"]', "Flat toolbar button");
  await page.waitForSelector("#flat-dialog[open]", { timeout: 10000 });
  await clickUnique(page, '#flat-form button[type="submit"]', "Flat Run button");
  const result = await waitForResult(
    page,
    () => {
      const summary = document.getElementById("flat-summary")?.textContent?.trim() || "";
      const rows = [...document.querySelectorAll("#flat-results [data-search-path]")].map((row) => row.textContent.trim());
      return {
        ok: /items/.test(summary) && rows.some((text) => text.includes("flat-target.md")),
        summary,
        rowCount: rows.length,
        hasFlatTarget: rows.some((text) => text.includes("flat-target.md"))
      };
    },
    "flat results"
  );
  const layout = await inspectDialogLayout(page, "flat-dialog");
  check(checks, "flat-summary", /items/.test(result.summary), `Flat summary: ${result.summary}.`);
  check(checks, "flat-nested-result", result.hasFlatTarget, `Flat row count ${result.rowCount}.`);
  check(checks, "flat-dialog-layout", layout.issues.length === 0, `${layout.issues.length} clipped/squished Flat control(s).`);
  await clickUnique(page, '[data-close-dialog="flat-dialog"]', "Flat close button");
  return { ...result, layoutIssues: layout.issues };
}

async function runDuplicates(page, checks) {
  await clickUnique(page, '[data-global-action="duplicates"]', "Duplicates toolbar button");
  await page.waitForSelector("#duplicates-dialog[open]", { timeout: 10000 });
  await clickUnique(page, '#duplicates-form button[type="submit"]', "Duplicate Scan button");
  const result = await waitForResult(
    page,
    () => {
      const summary = document.getElementById("duplicates-summary")?.textContent?.trim() || "";
      const groups = document.querySelectorAll("#duplicates-results .duplicate-group").length;
      const items = [...document.querySelectorAll("#duplicates-results .duplicate-item-row")].map((row) => row.textContent.trim());
      return {
        ok: /1 groups/.test(summary) && groups === 1 && items.length >= 2,
        summary,
        groups,
        items: items.slice(0, 6),
        hasBothDuplicates: items.some((text) => text.includes("duplicate-a.txt")) && items.some((text) => text.includes("duplicate-b.txt"))
      };
    },
    "duplicate results"
  );
  const layout = await inspectDialogLayout(page, "duplicates-dialog");
  check(checks, "duplicate-summary", /1 groups/.test(result.summary), `Duplicate summary: ${result.summary}.`);
  check(checks, "duplicate-hash-group", result.hasBothDuplicates, `Duplicate items: ${result.items.join(" | ")}.`);
  check(
    checks,
    "duplicates-dialog-layout",
    layout.issues.length === 0,
    `${layout.issues.length} clipped/squished Duplicate control(s).`
  );
  await clickUnique(page, '[data-close-dialog="duplicates-dialog"]', "Duplicates close button");
  return { ...result, layoutIssues: layout.issues };
}

async function runCompareAndPreview(page, checks) {
  await clickUnique(page, '[data-global-action="compare"]', "Compare toolbar button");
  await page.waitForSelector("#compare-dialog[open]", { timeout: 10000 });
  await clickUnique(page, '#compare-form button[type="submit"]', "Compare button");
  const compare = await waitForResult(
    page,
    () => {
      const summary = document.getElementById("compare-summary")?.textContent?.trim() || "";
      const rows = [...document.querySelectorAll("#compare-results .compare-row")].map((row) => ({
        relative: row.getAttribute("data-compare-relative") || "",
        text: row.textContent.trim()
      }));
      const statuses = rows.map((row) => row.text);
      return {
        ok:
          /shown/.test(summary) &&
          statuses.some((text) => text.includes("leftOnly")) &&
          statuses.some((text) => text.includes("rightOnly")) &&
          statuses.some((text) => text.includes("newerLeft")),
        summary,
        rowCount: rows.length,
        relatives: rows.map((row) => row.relative),
        statuses: statuses.slice(0, 12)
      };
    },
    "compare rows"
  );
  check(checks, "compare-summary", /shown/.test(compare.summary), `Compare summary: ${compare.summary}.`);
  check(
    checks,
    "compare-statuses",
    compare.statuses.some((text) => text.includes("leftOnly")) &&
      compare.statuses.some((text) => text.includes("rightOnly")) &&
      compare.statuses.some((text) => text.includes("newerLeft")),
    `Compare rows: ${compare.statuses.join(" | ")}.`
  );

  await clickUnique(page, '[data-compare-action="previewLeftToRight"]', "Plan L->R button");
  const preview = await waitForResult(
    page,
    () => {
      const summary = document.getElementById("compare-summary")?.textContent?.trim() || "";
      const rows = [...document.querySelectorAll("#sync-preview .sync-preview-row")].map((row) => row.textContent.trim());
      const applyDisabled = document.getElementById("compare-sync-apply")?.disabled !== false;
      return {
        ok: /planned/.test(summary) && rows.some((text) => text.includes("copy")) && rows.some((text) => text.includes("overwrite")),
        summary,
        rows: rows.slice(0, 12),
        applyEnabled: !applyDisabled
      };
    },
    "sync preview rows"
  );
  const layout = await inspectDialogLayout(page, "compare-dialog");
  check(checks, "sync-preview-summary", /planned/.test(preview.summary), `Sync preview summary: ${preview.summary}.`);
  check(
    checks,
    "sync-preview-actions",
    preview.rows.some((text) => text.includes("copy")) && preview.rows.some((text) => text.includes("overwrite")),
    `Sync preview rows: ${preview.rows.join(" | ")}.`
  );
  check(checks, "sync-preview-apply-ready", preview.applyEnabled, "Sync Apply button enabled after preview.");
  check(
    checks,
    "compare-dialog-layout",
    layout.issues.length === 0,
    `${layout.issues.length} clipped/squished Compare control(s).`
  );
  await clickUnique(page, '[data-close-dialog="compare-dialog"]', "Compare close button");
  return { compare, preview, layoutIssues: layout.issues };
}

async function proveNoSyncMutation() {
  const rightUpdate = await fs.readFile(path.join(rightFixture, "update.txt"), "utf8");
  const rightLeftOnlyExists = await fs
    .access(path.join(rightFixture, "left-only.txt"))
    .then(() => true)
    .catch(() => false);
  return {
    rightUpdateUnchanged: rightUpdate === "right older version\n",
    leftOnlyNotCopied: !rightLeftOnlyExists
  };
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Power Tools UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Tool Results

| Tool | Summary |
| --- | --- |
| Flat | ${String(report.flat?.summary || "n/a").replace(/\|/g, "\\|")} |
| Duplicates | ${String(report.duplicates?.summary || "n/a").replace(/\|/g, "\\|")} |
| Compare | ${String(report.compare?.compare?.summary || "n/a").replace(/\|/g, "\\|")} |
| Sync Preview | ${String(report.compare?.preview?.summary || "n/a").replace(/\|/g, "\\|")} |
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
  let flat = null;
  let duplicates = null;
  let compare = null;
  let diskProof = null;
  try {
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({ executablePath: edgePath(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        consoleMessages.push({ type: message.type(), text: message.text() });
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    await page.goto(
      `${baseUrl}/?left=${encodeURIComponent(leftFixture)}&right=${encodeURIComponent(rightFixture)}`,
      { waitUntil: "domcontentloaded" }
    );
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    await clickUnique(page, '[data-path-input="left"]', "Left path input");

    flat = await runFlat(page, checks);
    duplicates = await runDuplicates(page, checks);
    compare = await runCompareAndPreview(page, checks);
    diskProof = await proveNoSyncMutation();
    check(checks, "sync-preview-no-mutation", diskProof.rightUpdateUnchanged && diskProof.leftOnlyNotCopied, JSON.stringify(diskProof));
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
    leftFixture,
    rightFixture,
    flat,
    duplicates,
    compare,
    diskProof,
    consoleMessages,
    pageErrors,
    serverOutput: serverOutput.slice(-4000),
    summary,
    checks
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(latestMdPath, markdownReport(report));
  console.log(`power tools UI smoke: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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
