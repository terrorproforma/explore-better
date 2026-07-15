import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const root = process.cwd();
const workDir = path.join(root, "demo-video");
const outputDir = path.join(workDir, "output");
const frameDir = path.join(outputDir, "scenes");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const chrome = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const fps = 30;
const transitionDuration = 0.24;

const assets = (name) => path.join(root, "site", "assets", name);
const artifact = (name) => path.join(root, "artifacts", name);

const scenes = [
  {
    id: "01-one-operator",
    duration: 2.65,
    layout: "intro",
    accent: "#7ce7c3",
    eyebrow: "WINDOWS FILE WORK",
    headline: ["EXPLORER WAS BUILT", "FOR ONE OPERATOR."],
    footer: "THE OLD MODEL",
  },
  {
    id: "02-two-operators",
    duration: 3.0,
    layout: "intro-two",
    accent: "#ffcb66",
    eyebrow: "MEET EXPLORE BETTER",
    headline: ["THIS ONE IS BUILT", "FOR TWO."],
    body: "One visible workspace. Human judgment and AI speed.",
    footer: "HUMAN  +  AI",
  },
  {
    id: "03-workspace",
    duration: 4.35,
    layout: "showcase",
    accent: "#7ce7c3",
    eyebrow: "01 / THE WORKSPACE",
    headline: ["DUAL PANE.", "ZERO FRICTION."],
    body: "Tabs, previews, transfers and live file context—without losing your place.",
    chips: ["SOURCE / TARGET", "PER-TAB STATE", "NATIVE WINDOWS PATHS"],
    image: assets("workspace.png"),
    imageLabel: "EXPLORE BETTER / WORKSPACE",
  },
  {
    id: "04-scale",
    duration: 4.15,
    layout: "showcase-reverse",
    accent: "#70c8ff",
    eyebrow: "02 / BUILT FOR SCALE",
    headline: ["100,000 ENTRIES.", "STILL MOVES."],
    body: "Verified large-folder rendering with both panes alive and responsive.",
    chips: ["100K ENTRIES", "1.2s VERIFIED LOAD", "DUAL PANE"],
    image: assets("large-folder.png"),
    imageLabel: "100K-ENTRY STRESS RUN",
  },
  {
    id: "05-speed",
    duration: 3.55,
    layout: "metric",
    accent: "#ffcb66",
    eyebrow: "03 / MEASURED, NOT VIBES",
    metric: "54.7×",
    metricLabel: "LOWER MEDIAN\nFILENAME-SEARCH LATENCY",
    comparisons: [
      ["EXPLORE BETTER MCP", "9.8 ms"],
      ["FRESH POWERSHELL", "536.1 ms"],
      ["DISK ANALYSIS", "6.2×"],
      ["DUPLICATE FINDING", "4.5×"],
    ],
    footnote: "Published fixture. PowerShell comparison includes fresh process startup.",
  },
  {
    id: "06-disk-map",
    duration: 4.0,
    layout: "showcase",
    accent: "#f06f86",
    eyebrow: "04 / SEE THE WEIGHT",
    headline: ["SEE YOUR DISK.", "ACT ON IT."],
    body: "A visual map turns storage pressure into a decision you can make in seconds.",
    chips: ["ALLOCATED SIZE", "FILE TYPES", "TOP FILES"],
    image: assets("disk-map.png"),
    imageLabel: "SIZE ANALYZER / 100K-ENTRY RUN",
  },
  {
    id: "07-command",
    duration: 3.65,
    layout: "showcase-reverse",
    accent: "#b8a7ff",
    eyebrow: "05 / STAY ON THE KEYS",
    headline: ["108 ACTIONS.", "ONE LAUNCHER."],
    body: "Commands, tools and scripts—searchable from one keyboard-first surface.",
    chips: ["RECENT", "PINNED", "BUILT-IN + CUSTOM"],
    image: assets("command-center.png"),
    imageLabel: "COMMAND CENTER",
  },
  {
    id: "08-terminal",
    duration: 4.05,
    layout: "showcase",
    accent: "#7ce7c3",
    eyebrow: "06 / POWER WHERE YOU NEED IT",
    headline: ["A TERMINAL", "THAT FOLLOWS", "THE TAB."],
    body: "The shell opens in the folder you are already looking at. Context stays attached.",
    chips: ["PER TAB", "REAL PTY", "CURRENT FOLDER"],
    image: assets("terminal.png"),
    imageLabel: "INTEGRATED TERMINAL",
  },
  {
    id: "09-ai-bridge",
    duration: 5.0,
    layout: "showcase-reverse",
    accent: "#ffcb66",
    eyebrow: "07 / THE SHARED WORKSPACE",
    headline: ["YOUR AI.", "YOUR FOLDERS.", "YOUR RULES."],
    body: "Give Codex, Claude or Cursor typed file tools inside explicit, revocable boundaries.",
    chips: ["READ-ONLY DEFAULT", "SCOPED ROOTS", "28 TYPED TOOLS"],
    image: assets("ai-bridge.png"),
    imageLabel: "LOCAL MCP AI BRIDGE",
  },
  {
    id: "10-recovery",
    duration: 4.15,
    layout: "showcase",
    accent: "#f06f86",
    eyebrow: "08 / FILE WORK WITH A MEMORY",
    headline: ["PREVIEW.", "APPLY.", "RECOVER."],
    body: "When a transfer fails, Explore Better keeps the journal, the remainder and the route back.",
    chips: ["RETRY", "UNDO", "RECOVERY DETAILS"],
    image: artifact("explore-better-operation-recovery.png"),
    imageLabel: "RECOVERABLE OPERATIONS",
  },
  {
    id: "11-final",
    duration: 4.0,
    layout: "final",
    accent: "#7ce7c3",
    eyebrow: "EXPLORE BETTER",
    headline: ["THE WINDOWS FILE MANAGER", "BUILT FOR HUMANS AND AI."],
    body: "Fast. Local-first. Visible. Recoverable.",
    chips: ["WINDOWS 11", "OPEN SOURCE", "LOCAL MCP"],
    cta: "terrorproforma.github.io/explore-better",
  },
];

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function headlineHtml(lines = []) {
  return lines.map((line, index) => `<span${index === lines.length - 1 ? ' class="accent-line"' : ""}>${escapeHtml(line)}</span>`).join("");
}

function chipHtml(chips = []) {
  return chips.length ? `<div class="chips">${chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join("")}</div>` : "";
}

function comparisonHtml(items = []) {
  return `<div class="comparison-grid">${items.map(([label, value], index) => `
    <div class="comparison-row ${index < 2 ? "primary" : "secondary"}">
      <span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>
    </div>`).join("")}</div>`;
}

function visualHtml(scene) {
  if (!scene.image) return "";
  return `
    <div class="visual-shell">
      <div class="window-bar">
        <div class="window-dots"><i></i><i></i><i></i></div>
        <span>${escapeHtml(scene.imageLabel)}</span>
        <b>LIVE / LOCAL</b>
      </div>
      <div class="visual-image-wrap"><img src="${scene.imageData}" alt="" /></div>
      <div class="scan-line"></div>
    </div>`;
}

function sceneMarkup(scene, index) {
  const sceneNumber = String(index + 1).padStart(2, "0");
  if (scene.layout === "metric") {
    return `
      <main class="metric-layout">
        <section class="metric-hero">
          <p class="eyebrow">${escapeHtml(scene.eyebrow)}</p>
          <div class="giant-metric">${escapeHtml(scene.metric)}</div>
          <div class="metric-label">${escapeHtml(scene.metricLabel).replaceAll("\n", "<br>")}</div>
        </section>
        <section class="metric-details">${comparisonHtml(scene.comparisons)}</section>
        <p class="footnote">* ${escapeHtml(scene.footnote)}</p>
      </main>`;
  }
  if (scene.layout === "intro" || scene.layout === "intro-two") {
    return `
      <main class="intro-layout ${scene.layout}">
        <p class="eyebrow">${escapeHtml(scene.eyebrow)}</p>
        <h1>${headlineHtml(scene.headline)}</h1>
        ${scene.body ? `<p class="intro-body">${escapeHtml(scene.body)}</p>` : ""}
        <div class="operator-line">
          <span class="operator-dot human"></span>
          <i></i>
          <span class="operator-dot ai"></span>
        </div>
        <p class="intro-footer">${escapeHtml(scene.footer)}</p>
      </main>`;
  }
  if (scene.layout === "final") {
    return `
      <main class="final-layout">
        <div class="brand-mark large"><span>EB</span></div>
        <p class="eyebrow">${escapeHtml(scene.eyebrow)}</p>
        <h1>${headlineHtml(scene.headline)}</h1>
        <p class="final-body">${escapeHtml(scene.body)}</p>
        ${chipHtml(scene.chips)}
        <div class="cta">${escapeHtml(scene.cta)}</div>
      </main>`;
  }
  return `
    <main class="showcase-layout ${scene.layout}">
      <section class="copy-block">
        <p class="eyebrow">${escapeHtml(scene.eyebrow)}</p>
        <h1>${headlineHtml(scene.headline)}</h1>
        <p class="body-copy">${escapeHtml(scene.body)}</p>
        ${chipHtml(scene.chips)}
      </section>
      <section class="visual-block">${visualHtml(scene)}</section>
    </main>`;
}

function renderHtml(scene, index) {
  const sceneNumber = String(index + 1).padStart(2, "0");
  return `<!doctype html>
  <html><head><meta charset="utf-8"><style>
    :root { --accent:${scene.accent}; --ink:#07110f; --paper:#f4f1e8; --muted:#98aaa4; }
    * { box-sizing:border-box; }
    html, body { width:1920px; height:1080px; margin:0; overflow:hidden; }
    body { font-family:"Segoe UI", Arial, sans-serif; color:var(--paper); background:
      radial-gradient(circle at 78% 22%, color-mix(in srgb, var(--accent) 23%, transparent), transparent 28%),
      radial-gradient(circle at 18% 88%, rgba(23,115,92,.22), transparent 32%),
      #07110f; }
    body::before { content:""; position:absolute; inset:0; opacity:.18; background-image:
      linear-gradient(rgba(255,255,255,.055) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.055) 1px, transparent 1px); background-size:72px 72px; }
    body::after { content:""; position:absolute; inset:0; pointer-events:none; box-shadow:inset 0 0 180px rgba(0,0,0,.72); }
    .top-brand { position:absolute; z-index:5; top:42px; left:56px; display:flex; align-items:center; gap:18px; font-weight:760; letter-spacing:.08em; font-size:20px; }
    .brand-mark { width:48px; height:48px; border-radius:12px; display:grid; place-items:center; background:var(--paper); color:var(--ink); font-weight:900; letter-spacing:-.08em; box-shadow:0 0 0 1px rgba(255,255,255,.18), 0 18px 60px rgba(0,0,0,.35); }
    .brand-mark.large { width:118px; height:118px; border-radius:26px; font-size:42px; margin-bottom:26px; }
    .scene-no { position:absolute; z-index:5; top:52px; right:64px; color:var(--accent); font:700 18px/1 Consolas, monospace; letter-spacing:.18em; }
    .scene-no::before { content:"CUT / "; color:#667a74; }
    .eyebrow { margin:0 0 28px; color:var(--accent); font:760 19px/1.2 Consolas, monospace; letter-spacing:.14em; }
    h1 { margin:0; font-family:"Arial Black", "Segoe UI Black", sans-serif; font-weight:950; letter-spacing:-.058em; line-height:.91; text-transform:uppercase; }
    h1 span { display:block; }
    .accent-line { color:var(--accent); }
    .showcase-layout { position:relative; z-index:2; width:100%; height:100%; padding:150px 62px 58px; display:grid; grid-template-columns: 35% 65%; gap:34px; align-items:center; }
    .showcase-layout.showcase-reverse { grid-template-columns:65% 35%; }
    .showcase-reverse .copy-block { order:2; padding-left:34px; }
    .showcase-reverse .visual-block { order:1; }
    .copy-block { padding:20px 22px 20px 2px; }
    .copy-block h1 { font-size:73px; max-width:620px; }
    .body-copy { color:#bdc9c5; font-size:27px; line-height:1.38; max-width:570px; margin:34px 0 30px; }
    .chips { display:flex; flex-wrap:wrap; gap:10px; }
    .chips span { border:1px solid color-mix(in srgb, var(--accent) 58%, #263c35); color:#dfe8e4; background:rgba(8,22,18,.72); border-radius:999px; padding:11px 15px; font:700 14px/1 Consolas, monospace; letter-spacing:.055em; }
    .visual-block { min-width:0; }
    .visual-shell { position:relative; width:100%; aspect-ratio:1.6; border:1px solid rgba(255,255,255,.22); border-radius:22px; overflow:hidden; background:#e9eeea; box-shadow:0 44px 100px rgba(0,0,0,.55), 0 0 0 10px rgba(255,255,255,.025); transform:perspective(1800px) rotateY(-2deg) rotateX(1deg); }
    .showcase-reverse .visual-shell { transform:perspective(1800px) rotateY(2deg) rotateX(1deg); }
    .window-bar { height:47px; color:#cdd8d3; background:#111b18; display:flex; align-items:center; padding:0 18px; gap:16px; font:700 13px/1 Consolas, monospace; letter-spacing:.04em; }
    .window-bar > span { flex:1; text-align:center; color:#d9e2df; }
    .window-bar b { color:var(--accent); font-weight:700; }
    .window-dots { display:flex; gap:7px; }
    .window-dots i { width:9px; height:9px; border-radius:50%; background:#53655f; }
    .window-dots i:first-child { background:#f06f86; }.window-dots i:nth-child(2){background:#ffcb66}.window-dots i:last-child{background:#7ce7c3}
    .visual-image-wrap { height:calc(100% - 47px); overflow:hidden; background:#e7ece9; }
    .visual-image-wrap img { width:100%; height:100%; object-fit:cover; display:block; }
    .scan-line { position:absolute; left:0; right:0; top:48%; height:2px; opacity:.35; background:linear-gradient(90deg,transparent,var(--accent),transparent); box-shadow:0 0 24px var(--accent); }
    .intro-layout { position:relative; z-index:2; height:100%; display:flex; flex-direction:column; justify-content:center; padding:95px 150px 90px; }
    .intro-layout h1 { font-size:118px; max-width:1540px; }
    .intro-layout .eyebrow { margin-bottom:40px; }
    .intro-body { font-size:30px; color:#bdc9c5; margin:34px 0 0; }
    .intro-footer { position:absolute; left:154px; bottom:78px; margin:0; color:#72857f; font:700 17px/1 Consolas,monospace; letter-spacing:.18em; }
    .operator-line { position:absolute; right:145px; bottom:92px; display:flex; align-items:center; width:430px; }
    .operator-line i { height:2px; flex:1; background:linear-gradient(90deg,#7ce7c3,#ffcb66); box-shadow:0 0 22px rgba(124,231,195,.5); }
    .operator-dot { width:24px; height:24px; border-radius:50%; border:6px solid #07110f; box-shadow:0 0 0 2px currentColor,0 0 32px currentColor; }
    .operator-dot.human{color:#7ce7c3;background:#7ce7c3}.operator-dot.ai{color:#ffcb66;background:#ffcb66}
    .intro-two h1 { max-width:1320px; }
    .metric-layout { position:relative; z-index:2; height:100%; padding:154px 90px 85px; display:grid; grid-template-columns:57% 43%; align-items:center; }
    .metric-hero { padding:10px 50px; }
    .giant-metric { color:var(--accent); font-family:"Arial Black",sans-serif; font-weight:950; font-size:260px; line-height:.78; letter-spacing:-.09em; text-shadow:0 0 80px color-mix(in srgb,var(--accent) 28%,transparent); }
    .metric-label { margin-top:42px; font-family:"Arial Black",sans-serif; font-size:46px; line-height:1.02; letter-spacing:-.035em; }
    .metric-details { border-left:1px solid rgba(255,255,255,.15); padding-left:70px; }
    .comparison-grid { display:grid; gap:14px; }
    .comparison-row { display:flex; align-items:baseline; justify-content:space-between; padding:21px 24px; border:1px solid rgba(255,255,255,.13); background:rgba(4,14,11,.68); border-radius:14px; font:700 17px/1 Consolas,monospace; color:#8ca19a; }
    .comparison-row strong { font-size:38px; color:#f4f1e8; letter-spacing:-.04em; }
    .comparison-row.primary:first-child { border-color:color-mix(in srgb,var(--accent) 65%,transparent); background:color-mix(in srgb,var(--accent) 10%,#07110f); }
    .comparison-row.primary:first-child strong { color:var(--accent); }
    .comparison-row.secondary strong { font-size:29px; }
    .footnote { position:absolute; left:140px; bottom:58px; margin:0; color:#71857e; font:500 15px/1.3 Consolas,monospace; }
    .final-layout { position:relative; z-index:2; height:100%; padding:122px 150px 90px; display:flex; flex-direction:column; align-items:flex-start; justify-content:center; }
    .final-layout h1 { font-size:89px; max-width:1480px; }
    .final-layout .eyebrow { margin-bottom:25px; }
    .final-body { color:#bdc9c5; font-size:30px; margin:30px 0 24px; }
    .final-layout .chips { margin-bottom:34px; }
    .cta { border-left:5px solid var(--accent); padding:14px 20px; background:rgba(3,12,10,.72); color:#fff; font:700 25px/1 Consolas,monospace; letter-spacing:.025em; }
  </style></head>
  <body>
    <div class="top-brand"><div class="brand-mark"><span>EB</span></div><span>EXPLORE BETTER</span></div>
    <div class="scene-no">${sceneNumber}</div>
    ${sceneMarkup(scene, index)}
  </body></html>`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function writeWav(samplesLeft, samplesRight, sampleRate, outPath) {
  const frames = samplesLeft.length;
  const dataSize = frames * 4;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i += 1) {
    buffer.writeInt16LE(Math.round(clamp(samplesLeft[i], -1, 1) * 32767), 44 + i * 4);
    buffer.writeInt16LE(Math.round(clamp(samplesRight[i], -1, 1) * 32767), 46 + i * 4);
  }
  return fs.writeFile(outPath, buffer);
}

function noteFrequency(midi) {
  return 440 * (2 ** ((midi - 69) / 12));
}

async function generateMusic(duration, cutTimes, outPath) {
  const sampleRate = 48_000;
  const frames = Math.ceil(duration * sampleRate);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const bpm = 124;
  const beat = 60 / bpm;
  const chordRoots = [38, 34, 41, 36]; // D, Bb, F, C
  const chords = [[0, 3, 7], [0, 4, 7], [0, 4, 7], [0, 4, 7]];
  let seed = 0x53f21a9b;
  const noise = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1;
  };
  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate;
    const beatIndex = Math.floor(t / beat);
    const beatPhase = (t % beat) / beat;
    const halfPhase = (t % (beat / 2)) / (beat / 2);
    const bar = Math.floor(beatIndex / 4);
    const progression = bar % chordRoots.length;
    const root = chordRoots[progression];
    const chord = chords[progression];
    const barPhase = (t % (beat * 4)) / (beat * 4);
    const intro = clamp(t / 2.2, 0, 1);
    const outro = clamp((duration - t) / 2.0, 0, 1);
    const master = intro * outro;

    // Wide, slightly detuned pad.
    let padL = 0;
    let padR = 0;
    const padEnvelope = Math.sin(Math.PI * clamp(barPhase * 1.08, 0, 1)) ** 0.45;
    for (let c = 0; c < chord.length; c += 1) {
      const f = noteFrequency(root + 12 + chord[c]);
      padL += Math.sin(2 * Math.PI * (f * (0.998 - c * 0.0007)) * t + c * 0.7);
      padR += Math.sin(2 * Math.PI * (f * (1.002 + c * 0.0007)) * t + c * 1.1);
    }
    padL *= 0.042 * padEnvelope;
    padR *= 0.042 * padEnvelope;

    // Pulsed bass with a short filter-like overtone.
    const bassFreq = noteFrequency(root);
    const bassEnv = Math.exp(-beatPhase * 4.0) * (0.78 + 0.22 * Math.sin(Math.PI * beatPhase));
    const bass = (Math.sin(2 * Math.PI * bassFreq * t) + 0.24 * Math.sin(2 * Math.PI * bassFreq * 2 * t)) * 0.15 * bassEnv;

    // Eighth-note arpeggio.
    const arpStep = Math.floor(t / (beat / 2));
    const arpNotes = [0, 7, 12, 3, 7, 15, 12, 7];
    const arpFreq = noteFrequency(root + 24 + arpNotes[arpStep % arpNotes.length]);
    const arpEnv = Math.exp(-halfPhase * 7.5);
    const arp = (Math.sin(2 * Math.PI * arpFreq * t) + 0.3 * Math.sin(2 * Math.PI * arpFreq * 2 * t)) * 0.065 * arpEnv;

    // Kick, snare and hats.
    const kickFreq = 46 + 95 * Math.exp(-beatPhase * 30);
    const kick = Math.sin(2 * Math.PI * kickFreq * t) * Math.exp(-beatPhase * 13) * 0.34;
    const snareOn = beatIndex % 4 === 1 || beatIndex % 4 === 3;
    const snare = snareOn ? noise() * Math.exp(-beatPhase * 18) * 0.12 : 0;
    const hat = noise() * Math.exp(-halfPhase * 24) * 0.035;

    // Low impacts at edit points.
    let impact = 0;
    let whoosh = 0;
    for (const cut of cutTimes) {
      const d = t - cut;
      if (d >= 0 && d < 0.65) impact += Math.sin(2 * Math.PI * (54 - d * 22) * d) * Math.exp(-d * 7.0) * 0.23;
      const pre = cut - t;
      if (pre >= 0 && pre < 0.34) whoosh += noise() * (1 - pre / 0.34) * 0.05;
    }
    const mono = bass + arp + kick + snare + hat + impact + whoosh;
    left[i] = (padL + mono) * master * 0.82;
    right[i] = (padR + mono * 0.97) * master * 0.82;
  }
  await writeWav(left, right, sampleRate, outPath);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with ${code}`)));
  });
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`${path.basename(command)} exited with ${code}\n${output.slice(-4000)}`)));
  });
}

await fs.mkdir(frameDir, { recursive: true });
for (const scene of scenes) {
  if (scene.image) scene.imageData = `data:image/png;base64,${(await fs.readFile(scene.image)).toString("base64")}`;
}
const browser = await chromium.launch({ executablePath: chrome, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index];
    await page.setContent(renderHtml(scene, index), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    if (scene.image) await page.locator(".visual-image-wrap img").evaluate((img) => img.decode());
    await page.screenshot({ path: path.join(frameDir, `${scene.id}.png`), type: "png" });
  }
} finally {
  await browser.close();
}

let totalDuration = scenes.reduce((sum, scene) => sum + scene.duration, 0) - transitionDuration * (scenes.length - 1);
let cursor = scenes[0].duration;
const cutTimes = [];
for (let index = 1; index < scenes.length; index += 1) {
  cursor -= transitionDuration;
  cutTimes.push(cursor);
  cursor += scenes[index].duration;
}
const musicPath = path.join(outputDir, "explore-better-original-score.wav");
await generateMusic(totalDuration + 0.25, cutTimes, musicPath);
const mixTarget = { integrated: -14, truePeak: -2.5, range: 7 };
const loudnessPassOne = await runCapture(ffmpeg, [
  "-hide_banner", "-i", musicPath,
  "-af", `atrim=duration=${totalDuration.toFixed(3)},afade=t=in:st=0:d=0.5,afade=t=out:st=${Math.max(0, totalDuration - 1.6).toFixed(3)}:d=1.6,loudnorm=I=${mixTarget.integrated}:TP=${mixTarget.truePeak}:LRA=${mixTarget.range}:print_format=json`,
  "-f", "null", "NUL",
]);
const loudnessJson = loudnessPassOne.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0];
if (!loudnessJson) throw new Error("Could not parse first-pass loudness analysis.");
const loudness = JSON.parse(loudnessJson);

const inputArgs = [];
for (const scene of scenes) {
  inputArgs.push("-loop", "1", "-framerate", String(fps), "-t", String(scene.duration), "-i", path.join(frameDir, `${scene.id}.png`));
}
inputArgs.push("-i", musicPath);

const filters = [];
for (let index = 0; index < scenes.length; index += 1) {
  const scene = scenes[index];
  const frames = Math.round(scene.duration * fps);
  const reverse = index % 2 === 1;
  const zoomExpr = reverse
    ? `1.045-0.000${Math.max(18, Math.round(4500 / frames))}*on`
    : `1.000+0.000${Math.max(18, Math.round(4000 / frames))}*on`;
  filters.push(`[${index}:v]scale=1920:1080,zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=${fps},trim=duration=${scene.duration},setpts=PTS-STARTPTS,format=yuv420p[v${index}]`);
}
let composite = "v0";
let compositeDuration = scenes[0].duration;
const transitions = ["fade", "smoothleft", "fadeblack", "wipeleft", "fade", "smoothleft", "fadeblack", "wipeleft", "fade", "smoothleft"];
for (let index = 1; index < scenes.length; index += 1) {
  const offset = compositeDuration - transitionDuration;
  const out = `x${index}`;
  filters.push(`[${composite}][v${index}]xfade=transition=${transitions[index - 1]}:duration=${transitionDuration}:offset=${offset.toFixed(3)}[${out}]`);
  composite = out;
  compositeDuration += scenes[index].duration - transitionDuration;
}
filters.push(`[${scenes.length}:a]atrim=duration=${totalDuration.toFixed(3)},afade=t=in:st=0:d=0.5,afade=t=out:st=${Math.max(0, totalDuration - 1.6).toFixed(3)}:d=1.6,loudnorm=I=${mixTarget.integrated}:TP=${mixTarget.truePeak}:LRA=${mixTarget.range}:measured_I=${loudness.input_i}:measured_TP=${loudness.input_tp}:measured_LRA=${loudness.input_lra}:measured_thresh=${loudness.input_thresh}:offset=${loudness.target_offset}:linear=false,aresample=48000,alimiter=limit=0.50:attack=5:release=100:level=false[aout]`);

const videoPath = path.join(outputDir, "explore-better-hype-demo-1080p.mp4");
await run(ffmpeg, [
  "-y", ...inputArgs,
  "-filter_complex", filters.join(";"),
  "-map", `[${composite}]`, "-map", "[aout]",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-level", "4.1",
  "-pix_fmt", "yuv420p", "-r", String(fps),
  "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
  "-movflags", "+faststart", "-shortest", videoPath,
]);

const posterPath = path.join(outputDir, "explore-better-hype-demo-poster.png");
await run(ffmpeg, ["-y", "-ss", "31.5", "-i", videoPath, "-frames:v", "1", "-update", "1", posterPath]);

const contactPath = path.join(outputDir, "explore-better-hype-demo-contact-sheet.jpg");
await run(ffmpeg, [
  "-y", "-i", videoPath,
  "-vf", "fps=1/5,scale=480:270,tile=3x3:padding=8:margin=8:color=07110f",
  "-frames:v", "1", "-update", "1", "-q:v", "2", contactPath,
]);

const manifest = {
  title: "Explore Better — Hype Demo",
  durationSeconds: Number(totalDuration.toFixed(3)),
  resolution: "1920x1080",
  frameRate: fps,
  video: path.relative(root, videoPath),
  poster: path.relative(root, posterPath),
  contactSheet: path.relative(root, contactPath),
  audio: `Original procedural electronic score; two-pass target ${mixTarget.integrated} LUFS / ${mixTarget.truePeak} dBTP`,
  claims: {
    filenameSearch: "9.8 ms via MCP vs 536.1 ms via equivalent fresh PowerShell process (54.7x ratio)",
    diskAnalysis: "6.2x ratio on published fixture",
    duplicateFinding: "4.5x ratio on published fixture",
    typedTools: 28,
    largeFolder: "100,000-entry verified UI fixture",
  },
  generatedAt: new Date().toISOString(),
};
await fs.writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify(manifest, null, 2));
