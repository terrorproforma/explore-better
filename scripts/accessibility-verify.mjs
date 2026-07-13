import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `accessibility-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");

const viewports = [
  { name: "desktop", width: 1366, height: 860 },
  { name: "mobile", width: 390, height: 844 }
];

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function edgePath() {
  return (
    optionValue("--browser", process.env.EB_A11Y_BROWSER || "") ||
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
  await fs.mkdir(path.join(fixture, "00-open-folder"), { recursive: true });
  await fs.writeFile(path.join(fixture, "00-open-folder", "inside.txt"), "keyboard navigation target\n");
  await fs.writeFile(path.join(fixture, "01-report.txt"), "a11y fixture\n");
  await fs.writeFile(path.join(fixture, "02-notes.md"), "# notes\n");
  await fs.mkdir(appData, { recursive: true });
}

function accessibilityAuditSource() {
  return () => {
    const issues = [];
    const samples = [];

    const isHiddenByAncestor = (element) => {
      for (let node = element; node; node = node.parentElement) {
        if (node.hidden || node.getAttribute("aria-hidden") === "true") return true;
        if (node.tagName === "DIALOG" && !node.open) return true;
      }
      return false;
    };

    const isVisible = (element) => {
      if (!(element instanceof HTMLElement) || isHiddenByAncestor(element)) return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const textFrom = (element) => (element?.innerText || element?.textContent || "").trim().replace(/\s+/g, " ");

    const nameFromLabel = (element) => {
      const labels = [];
      if (element.id) {
        labels.push(...document.querySelectorAll(`label[for="${CSS.escape(element.id)}"]`));
      }
      const parentLabel = element.closest("label");
      if (parentLabel) labels.push(parentLabel);
      return [...new Set(labels)].map(textFrom).join(" ").trim();
    };

    const accessibleName = (element) => {
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const label = labelledBy
          .split(/\s+/)
          .map((id) => textFrom(document.getElementById(id)))
          .filter(Boolean)
          .join(" ")
          .trim();
        if (label) return label;
      }
      return (
        element.getAttribute("aria-label") ||
        nameFromLabel(element) ||
        element.getAttribute("alt") ||
        textFrom(element) ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        ""
      ).trim();
    };

    const describe = (element) => ({
      tag: element.tagName.toLowerCase(),
      id: element.id || "",
      role: element.getAttribute("role") || "",
      classes: element.className || "",
      text: textFrom(element).slice(0, 80)
    });

    const selector = [
      "button",
      "input:not([type='hidden'])",
      "select",
      "textarea",
      "a[href]",
      "[role='button']",
      "[role='menuitem']",
      "[role='option']",
      "[role='listbox']",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",");
    const seen = new Set();
    for (const element of document.querySelectorAll(selector)) {
      if (seen.has(element) || !isVisible(element)) continue;
      seen.add(element);
      const name = accessibleName(element);
      const description = describe(element);
      const title = element.getAttribute("title") || "";
      samples.push({ ...description, name });
      if (!name) {
        issues.push({ kind: "missing-accessible-name", ...description });
      }
      if (title && name.length <= 2 && title.trim().length > name.length) {
        issues.push({ kind: "ambiguous-accessible-name", name, title, ...description });
      }
      if (element.getAttribute("role") === "listbox") {
        const options = element.querySelectorAll("[role='option']");
        if (options.length && element.getAttribute("aria-multiselectable") !== "true") {
          issues.push({ kind: "listbox-missing-multiselectable", ...description });
        }
      }
    }

    const dialogs = [...document.querySelectorAll("dialog")].map((dialog) => {
      const name = accessibleName(dialog);
      if (!name) {
        issues.push({ kind: "dialog-missing-name", ...describe(dialog) });
      }
      return { id: dialog.id, name, labelledBy: dialog.getAttribute("aria-labelledby") || "" };
    });

    return { issues, samples, dialogs };
  };
}

async function tabFocusSequence(page, steps = 24) {
  const samples = [];
  await page.evaluate(() => document.activeElement?.blur?.());
  for (let index = 0; index < steps; index += 1) {
    await page.keyboard.press("Tab");
    const sample = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active === document.body) return null;
      const style = getComputedStyle(active);
      const rect = active.getBoundingClientRect();
      const outlineWidth = Number.parseFloat(style.outlineWidth) || 0;
      const focusIndicator =
        (outlineWidth >= 1 && style.outlineStyle !== "none") || (style.boxShadow && style.boxShadow !== "none");
      return {
        tag: active.tagName.toLowerCase(),
        id: active.id || "",
        role: active.getAttribute("role") || "",
        name: (
          active.getAttribute("aria-label") ||
          active.innerText ||
          active.textContent ||
          active.getAttribute("title") ||
          active.getAttribute("placeholder") ||
          active.id ||
          active.tagName
        )
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        focusVisible: active.matches(":focus-visible"),
        focusIndicator
      };
    });
    if (sample?.width && sample?.height) {
      samples.push(sample);
    }
  }
  return samples;
}

async function verifyKeyboardNavigation(page, folderPath) {
  const list = page.locator('[data-list="left"]');
  await list.focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForSelector('.pane.active [data-entry-path].focused', { timeout: 5000 });
  const focusedBefore = await page.locator('.pane.active [data-entry-path].focused').evaluate((element) => ({
    path: element.dataset.entryPath,
    label: element.getAttribute("aria-label") || "",
    activeDescendant: element.closest("[role='listbox']")?.getAttribute("aria-activedescendant") || "",
    id: element.id
  }));
  if (focusedBefore.path !== folderPath) {
    throw new Error(`Keyboard focus landed on ${focusedBefore.path}, expected ${folderPath}`);
  }
  if (!focusedBefore.activeDescendant || focusedBefore.activeDescendant !== focusedBefore.id) {
    throw new Error("File list aria-activedescendant does not match the focused item.");
  }
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (targetPath) => document.querySelector('[data-path-input="left"]')?.value === targetPath,
    folderPath,
    { timeout: 5000 }
  );
  return focusedBefore;
}

async function verifyCommandHotkey(page) {
  await page.keyboard.press("Control+P");
  await page.waitForSelector("#command-dialog[open]", { timeout: 5000 });
  return page.evaluate(() => ({
    dialogName:
      document
        .querySelector("#command-dialog")
        ?.getAttribute("aria-labelledby")
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
        .join(" ") || "",
    focusedId: document.activeElement?.id || ""
  }));
}

async function verifyForcedColorsFocus(page) {
  await page.emulateMedia({ forcedColors: "active" });
  await page.locator('[data-list="left"]').focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForSelector('.pane.active [data-entry-path].focused', { timeout: 5000 });
  return page.locator('.pane.active [data-entry-path].focused').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      forcedColors: matchMedia("(forced-colors: active)").matches,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      background: style.backgroundColor,
      color: style.color
    };
  });
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await prepareFixture();
  const folderPath = path.join(fixture, "00-open-folder");
  const port = Number(optionValue("--port", process.env.PORT || 49000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
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

  const browser = await chromium.launch({ executablePath: edgePath(), headless: true });
  const reports = [];
  try {
    await waitForServer(baseUrl, server);
    const page = await browser.newPage();
    for (const viewport of viewports) {
      await page.emulateMedia({ forcedColors: "none" });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, {
        waitUntil: "domcontentloaded"
      });
      await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
      const audit = await page.evaluate(accessibilityAuditSource());
      const focusSamples = await tabFocusSequence(page);
      const focusIssues = focusSamples
        .filter((sample) => !sample.focusIndicator)
        .map((sample) => ({ kind: "missing-visible-focus", ...sample }));
      const keyboard = viewport.name === "desktop" ? await verifyKeyboardNavigation(page, folderPath) : null;
      const command = viewport.name === "desktop" ? await verifyCommandHotkey(page) : null;
      const commandIssues = [];
      if (command && command.dialogName !== "Command Center") {
        commandIssues.push({ kind: "command-dialog-missing-name", ...command });
      }
      if (command && command.focusedId !== "command-input") {
        commandIssues.push({ kind: "command-dialog-input-not-focused", ...command });
      }
      const forcedColors =
        viewport.name === "desktop"
          ? await page
              .goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, {
                waitUntil: "domcontentloaded"
              })
              .then(() => page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 }))
              .then(() => verifyForcedColorsFocus(page))
          : null;
      const forcedColorIssues = [];
      if (forcedColors) {
        const outlineWidth = Number.parseFloat(forcedColors.outlineWidth) || 0;
        if (!forcedColors.forcedColors || forcedColors.outlineStyle === "none" || outlineWidth < 1) {
          forcedColorIssues.push({ kind: "forced-colors-focus-missing", ...forcedColors });
        }
      }
      const screenshot = path.join(artifactsDir, `accessibility-${viewport.name}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      const issues = [...audit.issues, ...focusIssues, ...commandIssues, ...forcedColorIssues];
      reports.push({
        ...viewport,
        screenshot,
        issueCount: issues.length,
        issues,
        sampleCount: audit.samples.length,
        focusSamples,
        dialogs: audit.dialogs,
        keyboard,
        command,
        forcedColors
      });
      console.log(`${viewport.name}: ${issues.length} accessibility issue(s)`);
    }
    const output = {
      generatedAt: new Date().toISOString(),
      fixture,
      reports
    };
    const jsonPath = path.join(artifactsDir, "accessibility-verification-latest.json");
    await fs.writeFile(jsonPath, JSON.stringify(output, null, 2), "utf8");
    console.log(`wrote ${jsonPath}`);
    const issueCount = reports.reduce((sum, report) => sum + report.issueCount, 0);
    if (issueCount > 0) {
      console.error(
        JSON.stringify(
          reports.flatMap((report) => report.issues.map((issue) => ({ viewport: report.name, ...issue }))),
          null,
          2
        )
      );
      process.exitCode = 1;
    }
  } finally {
    await browser.close().catch(() => {});
    server.kill();
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(serverOutput);
  console.error(error);
  process.exitCode = 1;
});
