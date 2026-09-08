import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";
import { transform } from "esbuild";

// Compare production renderer code against a Git revision using the same
// files, server, stylesheet, viewport and browser. Run without other benchmarks.
const root = process.cwd();
const baseline = process.argv.find(arg => arg.startsWith("--baseline="))?.slice(11);
const count = Number(process.argv.find(arg => arg.startsWith("--count="))?.slice(8) || 1800);
if (!Number.isInteger(count) || count < 1 || count > 100000) throw new Error("--count must be 1–100000");
const run = path.join(root, "artifacts", `renderer-interaction-${Date.now()}`);
const fixture = path.join(run, "Documents");
const appData = path.join(run, "appdata");
await Promise.all([fixture, appData].map(folder => fs.mkdir(folder, { recursive: true })));
for (let start = 0; start < count; start += 100) {
  await Promise.all(Array.from({ length: Math.min(100, count - start) }, (_, offset) => {
    const index = start + offset + 1;
    return fs.writeFile(path.join(fixture, `Document ${String(index).padStart(5, "0")}.txt`), `Document ${index}\n`);
  }));
}
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: root, windowsHide: true,
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
server.stdout.on("data", data => { output += data; });
server.stderr.on("data", data => { output += data; });
let browser;
const results = [];
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw new Error(output);
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Server did not start: ${output}`);
  browser = await chromium.launch({ executablePath: process.env.EB_INTERACTION_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  for (const revision of [...(baseline ? [baseline] : []), "working-tree"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    if (revision !== "working-tree") {
      const source = execFileSync("git", ["show", `${revision}:public/app.js`], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      const { code } = await transform(source, { format: "iife", minify: true, target: "chrome136" });
      await page.route("**/generated/app-runtime.js", route => route.fulfill({ contentType: "text/javascript", body: code }));
    }
    await page.goto(`${url}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`);
    await page.waitForFunction(() => Boolean(window.__exploreBetterStartup?.completedAt));
    const metrics = await page.evaluate(async () => {
      const list = document.querySelector('[data-list="left"]');
      const filter = document.querySelector('[data-filter="left"]');
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const settle = async () => {
        await frame();
        while (list.querySelector("[data-render-progress]")) await frame();
        await frame();
      };
      await settle();
      const initialRows = list.querySelectorAll('[data-entry-path]').length;
      const queries = ["Document 00", "Document 001", "", "Document 01", "", "Document 0001", "", "Document 017", ""];
      const samples = [];
      // Warm the filtering path before recording.
      for (const query of ["warmup", "", ...queries]) {
        filter.value = query;
        const start = performance.now();
        filter.dispatchEvent(new Event("input", { bubbles: true }));
        const handlerMs = performance.now() - start;
        await settle();
        samples.push({ query, handlerMs, settledMs: performance.now() - start, rows: list.querySelectorAll('[data-entry-path]').length });
      }
      const refresh = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        document.querySelector('[data-action="refresh"][data-pane="left"]').click();
        do { await frame(); } while (document.querySelector('.pane[data-pane="left"]').getAttribute('aria-busy') === 'true');
        await settle();
        refresh.push(performance.now() - start);
      }
      return { initialRows, samples: samples.slice(2), refreshMs: refresh };
    });
    if (errors.length) throw new Error(errors.join("\n"));
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const round = value => Math.round(value * 10) / 10;
    results.push({ revision, count, initialRows: metrics.initialRows, medianFilterHandlerMs: round(median(metrics.samples.map(sample => sample.handlerMs))), medianFilterSettledMs: round(median(metrics.samples.map(sample => sample.settledMs))), medianRefreshMs: round(median(metrics.refreshMs)), samples: metrics.samples, refreshMs: metrics.refreshMs });
    await page.close();
  }
  const report = { generatedAt: new Date().toISOString(), browser: browser.version(), viewport: "1440x960", results };
  await fs.writeFile(path.join(root, "artifacts", "renderer-interaction-latest.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(results.map(({samples, refreshMs, ...summary}) => summary), null, 2));
} finally {
  await browser?.close();
  server.kill();
}
