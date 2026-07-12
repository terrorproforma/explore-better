import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const artifacts = path.join(root, "artifacts");

function cleanText(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

function slug(value) {
  return String(value || "action").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "action";
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function expectedFor(action, label) {
  const text = `${action} ${label}`.toLowerCase();
  if (/delete|trash|remove|clear/.test(text)) return { screen: "Confirmation or completion state is visible and focus remains coherent.", filesystem: "Only the selected target changes; protected roots and app state remain intact." };
  if (/copy|move|paste|sync|transfer|rename|create|mkdir|archive|extract/.test(text)) return { screen: "Progress, completion, conflict, and error states render without blocking navigation.", filesystem: "The previewed paths and bytes match the committed operation journal." };
  if (/open|navigate|back|forward|parent|home|tab|favorite|location/.test(text)) return { screen: "The intended pane or tab updates, selection resets correctly, and rows appear.", filesystem: "No filesystem mutation occurs." };
  if (/size|analy/.test(text)) return { screen: "Analyzer opens, scans, labels allocation accuracy, and renders tables plus treemap.", filesystem: "Read-only scan; no filesystem mutation occurs." };
  if (/resize|layout|pane|inspector|dock/.test(text)) return { screen: "The target region resizes without overlap or inner horizontal scrollbars and persists after restart.", filesystem: "No filesystem mutation occurs; layout state is persisted atomically." };
  return { screen: "The command produces its visible enabled, loading, success, disabled, and error states.", filesystem: "No unexpected filesystem or registry mutation occurs." };
}

async function main() {
  const html = await fs.readFile(path.join(root, "public", "index.html"), "utf8");
  const app = await fs.readFile(path.join(root, "public", "app.js"), "utf8");
  const rows = [];
  const seen = new Set();
  const actionPattern = /<([a-z0-9-]+)([^>]*?data-([a-z0-9-]*action)="([^"]+)"[^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = actionPattern.exec(html))) {
    const [, tag, attributes, attribute, action, content] = match;
    const aria = attributes.match(/aria-label="([^"]+)"/i)?.[1];
    const title = attributes.match(/title="([^"]+)"/i)?.[1];
    const label = cleanText(aria || title || content || action);
    const id = `${attribute}:${action}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const expected = expectedFor(action, label);
    rows.push({
      id,
      surface: "visible-control",
      selector: `[data-${attribute}="${action}"]`,
      label,
      preconditions: attributes.includes("disabled") ? "Reach the state that enables this control." : "App is open and the control is visible.",
      physicalAction: tag === "button" ? "Click once; repeat with keyboard activation and relevant selection state." : "Activate the control with mouse and keyboard.",
      expectedScreenState: expected.screen,
      expectedFilesystemState: expected.filesystem,
      evidenceFilename: `action-${slug(attribute)}-${slug(action)}.png`
    });
  }

  const globalActionPattern = /\b(?:id|action):\s*["']([a-zA-Z0-9_-]+)["'][\s\S]{0,180}?\b(?:label|name|title):\s*["'`]([^"'`]+)["'`]/g;
  while ((match = globalActionPattern.exec(app))) {
    const action = match[1];
    const label = cleanText(match[2]);
    const id = `registered:${action}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const expected = expectedFor(action, label);
    rows.push({
      id,
      surface: "registered-action",
      selector: action,
      label,
      preconditions: "Open the toolbar, menu, command palette, or context that exposes this registered command.",
      physicalAction: "Invoke with mouse, then invoke its keyboard or command-palette equivalent where available.",
      expectedScreenState: expected.screen,
      expectedFilesystemState: expected.filesystem,
      evidenceFilename: `registered-${slug(action)}.png`
    });
  }

  const keyboardPattern = /(?:event|input)\.key\s*===\s*["']([^"']+)["']/g;
  while ((match = keyboardPattern.exec(app))) {
    const key = match[1];
    const id = `keyboard:${key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      surface: "keyboard",
      selector: key,
      label: key,
      preconditions: "Focus each applicable primary surface and repeat with no selection, one selection, and multiple selections.",
      physicalAction: `Press ${key}; repeat with documented modifier combinations.`,
      expectedScreenState: "Focus, selection, navigation, dialog, or command state changes exactly once with no browser-default leak.",
      expectedFilesystemState: "Only explicitly destructive shortcuts may mutate files, after the normal confirmation/preview path.",
      evidenceFilename: `keyboard-${slug(key)}.png`
    });
  }

  rows.sort((a, b) => `${a.surface}:${a.label}`.localeCompare(`${b.surface}:${b.label}`, undefined, { numeric: true }));
  const generatedAt = new Date().toISOString();
  const report = { schema: "explore-better.action-inventory.v1", generatedAt, sourceFiles: ["public/index.html", "public/app.js"], count: rows.length, rows };
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, "action-inventory-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  const headers = ["id", "surface", "selector", "label", "preconditions", "physicalAction", "expectedScreenState", "expectedFilesystemState", "evidenceFilename"];
  const csv = [headers.map(csvCell).join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\n");
  await fs.writeFile(path.join(artifacts, "action-inventory-latest.csv"), `${csv}\n`);
  const matrix = {
    schema: "explore-better.computer-use-matrix.v1",
    generatedAt,
    status: "pending-physical-execution",
    environments: [
      { viewport: "1366x768", scaling: "100%", windows: ["maximized", "snapped", "restored"] },
      { viewport: "1920x1080", scaling: "150%", windows: ["maximized", "snapped", "restored", "dual-monitor"] },
      { viewport: "3440x1440", scaling: "200%", windows: ["maximized", "snapped", "restored", "dual-monitor"] }
    ],
    actions: rows.map((row) => ({ actionId: row.id, evidenceFilename: row.evidenceFilename, status: "pending", machine: null, operator: null, completedAt: null }))
  };
  await fs.writeFile(path.join(artifacts, "computer-use-matrix-latest.json"), `${JSON.stringify(matrix, null, 2)}\n`);
  console.log(`Action inventory: ${rows.length} controls and keyboard actions`);
  console.log(`Wrote ${path.join(artifacts, "action-inventory-latest.csv")}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
