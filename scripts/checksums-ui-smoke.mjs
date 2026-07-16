import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";
import { clickDockAction } from "./ui-helpers.mjs";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `checksums-ui-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const alphaFile = path.join(fixture, "alpha.txt");
const bravoFile = path.join(fixture, "bravo.dat");
const largeFile = path.join(fixture, "large.bin");
const folder = path.join(fixture, "folder-target");
const manifestFile = path.join(fixture, "verification.sha256");
const latestJsonPath = path.join(artifactsDir, "checksums-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "checksums-ui-latest.md");
const screenshotPath = path.join(artifactsDir, "checksums-ui-latest.png");

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function requestJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function waitForServer(baseUrl, child, output) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) throw new Error(`Server exited early with ${child.exitCode}: ${output()}`);
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start at ${baseUrl}: ${output()}`);
}

async function prepareFixture() {
  const alpha = "alpha checksum\n";
  const bravo = "bravo checksum\n";
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.writeFile(alphaFile, alpha, "utf8");
  await fs.writeFile(bravoFile, bravo, "utf8");
  await fs.writeFile(path.join(folder, "child.txt"), "folder child\n", "utf8");
  await fs.writeFile(largeFile, Buffer.alloc(1024 * 1024 + 32, 7));
  const alphaHash = createHash("sha256").update(alpha).digest("hex");
  const wrongHash = "0".repeat(64);
  await fs.writeFile(
    manifestFile,
    `${alphaHash} *alpha.txt\n${wrongHash} *bravo.dat\n${alphaHash} *missing.txt\nnot a checksum line\n`,
    "utf8"
  );
  return {
    alphaHash,
    bravoHash: createHash("sha256").update(bravo).digest("hex")
  };
}

function row(page, name) {
  return page.locator('.pane[data-pane="left"] [data-entry-path]').filter({ hasText: name }).first();
}

async function selectRows(page, names) {
  await page.locator('[data-list="left"]').focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+i");
  for (const [index, name] of names.entries()) {
    const target = row(page, name);
    await target.waitFor({ state: "visible", timeout: 10000 });
    await target.click({ modifiers: index ? ["Control"] : [] });
  }
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.pane[data-pane="left"] [data-entry-path][aria-selected="true"]').length === expected,
    names.length
  );
}

async function openChecksums(page) {
  await clickDockAction(page, "checksums");
  await page.waitForSelector("#checksums-dialog[open]", { timeout: 10000 });
}

async function closeChecksums(page) {
  await page.locator('[data-close-dialog="checksums-dialog"]').click();
  await page.waitForFunction(() => !document.getElementById("checksums-dialog")?.open);
}

async function runGenerate(page, expectedPattern) {
  await page.locator("#checksums-form").evaluate((form) => form.requestSubmit());
  await page.waitForFunction(
    (source) => new RegExp(source, "i").test(document.getElementById("checksums-summary")?.textContent || ""),
    expectedPattern.source
  );
  return page.evaluate(() => ({
    summary: document.getElementById("checksums-summary")?.textContent?.trim() || "",
    note: document.getElementById("checksums-target-note")?.textContent?.trim() || "",
    preview: document.getElementById("checksums-preview")?.value || "",
    targets: [...document.querySelectorAll("#checksums-target-list .checksums-target-row")].map((item) => item.textContent.replace(/\s+/g, " ").trim()),
    rows: [...document.querySelectorAll("#checksums-results .checksums-result-row")].map((item) => item.textContent.replace(/\s+/g, " ").trim())
  }));
}

async function inspectLayout(page) {
  return page.evaluate(() => {
    const root = document.getElementById("checksums-dialog");
    const issues = [];
    for (const element of root?.querySelectorAll("button, input, select, textarea, label, .checksums-target-row, .checksums-result-row") || []) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) continue;
      const scrollSurface = element.matches("textarea");
      const intentionalOverflow = style.overflowX === "auto" || style.textOverflow === "ellipsis";
      const clipped = !scrollSurface && !intentionalOverflow && (element.scrollWidth > element.clientWidth + 4 || element.scrollHeight > element.clientHeight + 4);
      const squished = rect.width < 24 || rect.height < 18;
      if (clipped || squished) issues.push({ tag: element.tagName.toLowerCase(), text: element.textContent.trim().slice(0, 100), clipped, squished, width: Math.round(rect.width), height: Math.round(rect.height) });
    }
    return { issues };
  });
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Checksums UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fixtureHashes = await prepareFixture();
  const port = Number(process.env.PORT || "") || (await freePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const evidence = {};
  const pageErrors = [];
  const consoleErrors = [];
  const apiFailures = [];
  let copiedText = "";
  let serverOutput = "";
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

  let browser;
  try {
    await waitForServer(baseUrl, server, () => serverOutput);
    browser = await chromium.launch({
      executablePath: process.env.EB_CHECKSUMS_UI_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true
    });
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 }, acceptDownloads: true });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("response", async (response) => {
      if (response.url().includes("/api/") && response.status() >= 400) {
        apiFailures.push({ status: response.status(), url: response.url(), body: (await response.text().catch(() => "")).slice(0, 300) });
      }
    });
    await page.route("**/api/clipboard/text", async (route) => {
      const body = route.request().postDataJSON();
      copiedText = String(body?.text || "");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ chars: copiedText.length, lines: copiedText.split(/\r?\n/).filter(Boolean).length }) });
    });
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, { waitUntil: "domcontentloaded" });
    await row(page, "alpha.txt").waitFor({ state: "visible", timeout: 10000 });

    await selectRows(page, ["alpha.txt", "bravo.dat"]);
    await openChecksums(page);
    evidence.initial = await page.evaluate(() => ({
      summary: document.getElementById("checksums-summary")?.textContent || "",
      note: document.getElementById("checksums-target-note")?.textContent || "",
      verifyDisabled: document.querySelector('[data-checksums-action="verify"]')?.disabled,
      targets: [...document.querySelectorAll("#checksums-target-list .checksums-target-row")].map((item) => item.textContent.replace(/\s+/g, " ").trim())
    }));
    check(
      checks,
      "checksum-target-language-and-actions",
      evidence.initial.summary === "2 targets ready" &&
        /Generates checksums for selected files/.test(evidence.initial.note) &&
        evidence.initial.verifyDisabled === true &&
        evidence.initial.targets.every((item) => /^File\b/.test(item)),
      JSON.stringify(evidence.initial)
    );

    evidence.manifest = await runGenerate(page, /Hashed 2 files/);
    check(
      checks,
      "checksum-sha256-generation",
      evidence.manifest.preview.includes(`${fixtureHashes.alphaHash} *alpha.txt`) &&
        evidence.manifest.preview.includes(`${fixtureHashes.bravoHash} *bravo.dat`) &&
        !/skipped 0/i.test(evidence.manifest.summary),
      JSON.stringify({ summary: evidence.manifest.summary, preview: evidence.manifest.preview })
    );
    check(checks, "checksum-result-language", evidence.manifest.rows.length === 2 && evidence.manifest.rows.every((item) => /^Verified\b/.test(item)), evidence.manifest.rows.join(" | "));

    await page.locator("#checksums-format").selectOption("csv");
    check(checks, "checksum-option-reset", (await page.locator("#checksums-summary").textContent()) === "Options changed", await page.locator("#checksums-summary").textContent());
    evidence.csv = await runGenerate(page, /Hashed 2 files/);
    check(checks, "checksum-csv-format", /^"algorithm","hash","name","path","size"/.test(evidence.csv.preview), evidence.csv.preview.slice(0, 120));

    await page.locator("#checksums-format").selectOption("json");
    evidence.json = await runGenerate(page, /Hashed 2 files/);
    check(checks, "checksum-json-format", JSON.parse(evidence.json.preview).items.length === 2, evidence.json.preview.slice(0, 120));

    await page.locator('[data-checksums-action="copy"]').click();
    await page.waitForFunction(() => /Copied \d+ line/.test(document.getElementById("checksums-summary")?.textContent || ""));
    check(checks, "checksum-copy-action", copiedText === evidence.json.preview && /Copied \d+ character/.test(await page.locator("#toast").textContent()), await page.locator("#toast").textContent());

    const downloadPromise = page.waitForEvent("download");
    await page.locator('[data-checksums-action="download"]').click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    const downloadedText = await fs.readFile(downloadPath, "utf8");
    check(
      checks,
      "checksum-download-action",
      download.suggestedFilename().endsWith(".json") && downloadedText === evidence.json.preview && /manifest downloaded/i.test(await page.locator("#toast").textContent()),
      download.suggestedFilename()
    );
    const generationLayout = await inspectLayout(page);
    check(checks, "checksum-generation-layout", generationLayout.issues.length === 0, JSON.stringify(generationLayout.issues));
    await closeChecksums(page);

    await selectRows(page, ["verification.sha256"]);
    await openChecksums(page);
    evidence.verifyInitial = await page.evaluate(() => ({
      note: document.getElementById("checksums-target-note")?.textContent || "",
      verifyDisabled: document.querySelector('[data-checksums-action="verify"]')?.disabled,
      target: document.querySelector("#checksums-target-list .checksums-target-row")?.textContent.replace(/\s+/g, " ").trim() || ""
    }));
    check(
      checks,
      "checksum-manifest-recognition",
      /Verify checks verification\.sha256/.test(evidence.verifyInitial.note) && evidence.verifyInitial.verifyDisabled === false && /^File\b/.test(evidence.verifyInitial.target),
      JSON.stringify(evidence.verifyInitial)
    );
    await page.locator('[data-checksums-action="verify"]').click();
    await page.waitForFunction(() => /1 verified.*1 mismatch.*1 missing.*1 skipped/i.test(document.getElementById("checksums-summary")?.textContent || ""));
    evidence.verification = await page.evaluate(() => ({
      summary: document.getElementById("checksums-summary")?.textContent || "",
      rows: [...document.querySelectorAll("#checksums-results .checksums-result-row")].map((item) => item.textContent.replace(/\s+/g, " ").trim()),
      preview: document.getElementById("checksums-preview")?.value || ""
    }));
    check(
      checks,
      "checksum-verification-outcomes",
      ["Verified", "Mismatch", "Missing", "Skipped"].every((status) => evidence.verification.rows.some((item) => item.startsWith(status))) &&
        /MISMATCH/.test(evidence.verification.preview) &&
        /MISSING/.test(evidence.verification.preview) &&
        !evidence.verification.rows.some((item) => /ENOENT|EACCES|EPERM/.test(item)),
      JSON.stringify(evidence.verification)
    );
    await closeChecksums(page);

    await selectRows(page, ["large.bin"]);
    await openChecksums(page);
    await page.locator("#checksums-max-hash").fill("1");
    evidence.limit = await runGenerate(page, /Skipped 1 file/);
    check(
      checks,
      "checksum-size-limit-language",
      evidence.limit.rows.some((item) => /Skipped.*Larger than 1(?:\.0)? MB/i.test(item)) && !evidence.limit.rows.some((item) => /1048576/.test(item)),
      evidence.limit.rows.join(" | ")
    );
    await closeChecksums(page);

    await selectRows(page, ["folder-target"]);
    await openChecksums(page);
    evidence.folder = await runGenerate(page, /Skipped 1 folder/);
    check(
      checks,
      "checksum-folder-empty-state",
      /Select one or more files; folders are not hashed/.test(evidence.folder.note) && /Skipped 1 folder/.test(evidence.folder.summary),
      JSON.stringify({ summary: evidence.folder.summary, note: evidence.folder.note })
    );
    await closeChecksums(page);

    check(checks, "checksum-page-errors-clean", pageErrors.length === 0, JSON.stringify(pageErrors));
    check(checks, "checksum-console-errors-clean", consoleErrors.length === 0, JSON.stringify(consoleErrors));
    check(checks, "checksum-api-errors-clean", apiFailures.length === 0, JSON.stringify(apiFailures));
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (error) {
    check(checks, "smoke-execution", false, error.stack || error.message);
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
    evidence,
    pageErrors,
    consoleErrors,
    apiFailures,
    serverOutput: serverOutput.slice(-4000),
    summary,
    checks
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(latestMdPath, markdownReport(report));
  console.log(`checksums UI smoke: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
