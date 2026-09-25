// Edit decision list for the per-feature website clips. Every segment is addressed relative
// to a marker that capture-features.mjs recorded, so a fresh capture re-times the edit.
//
// Camera keyframes are [time, zoom, x, y]: time is seconds into the segment or [marker, offset];
// x/y are the frame centre in capture CSS pixels (1440x900), or "rect:<name>" for the centre
// of a rectangle the capture recorded. Zoom 1 shows the whole window.

export const FPS = 30;
export const WIDTH = 1280;
export const HEIGHT = 800;
const SPACE = { width: 1440, height: 900 };
const FULL = [0, 1, 720, 450];

export const CLIPS = [
  {
    id: "dual-pane",
    title: "Dual panes and tabs",
    summary: "Two independent panes, each with its own tabs, breadcrumbs and view mode.",
    alt: "A new tab opens in the left pane and drills into 02 Product and Renders, switches to a thumbnail tiles view, steps back with the breadcrumb, returns to the first tab, then focus moves to the right pane.",
    segments: [
      { from: ["start", 0.55], to: ["tab-switch", 0.75], cam: [FULL, [["tab-open", -0.4], 1.18, 560, 380], [["tiles", 0.2], 1.18, 560, 420], [["tab-switch", -0.2], 1.05, 640, 430], [["tab-switch", 0.6], 1, 720, 450]] },
      { from: ["focus-right", -0.6], to: ["focus-right", 0.9], cam: [FULL] }
    ],
    poster: ["tiles", -0.1],
    posterOutputSeconds: 4.69
  },
  {
    id: "terminal",
    title: "A terminal in every tab",
    summary: "Each tab's PowerShell follows the folder you open in the pane.",
    alt: "Ctrl+` opens a PowerShell drawer under the Project files pane. Opening the 04 Launch folder sends a Set-Location to the prompt, and Get-ChildItem | Select -First 5 lists the folder's files.",
    segments: [
      { from: ["start", 0.5], to: ["end", -0.1], cam: [FULL, [["drawer", 0.2], 1, 720, 450], [["follow", -0.3], 1.12, 760, 460], [["follow", 1.2], 1.12, 760, 460], [["run", 0.3], 1.2, 760, 600]] }
    ],
    poster: ["end", -0.4]
  },
  {
    id: "disk-map",
    title: "Disk Map",
    summary: "A nested treemap of exact disk allocation, with the largest files beside it.",
    alt: "Disk Map scans C:\\Demo\\Project files and draws a nested treemap coloured by file type. Hovering names each block, focusing 02 Product zooms the map into that folder, and the Top Files table lists the biggest files.",
    segments: [
      { from: ["dialog", -0.8], to: ["end", -0.1], cam: [FULL, [["mapped", 0.3], 1, 720, 450], [["hover", -0.2], 1.2, 610, 620], [["drill", 1.2], 1.2, 610, 620], [["files", 0.2], 1.3, 1250, 560]] }
    ],
    poster: ["mapped", 0.8]
  },
  {
    id: "transfer",
    title: "Transfer preview and undo",
    summary: "See every copy, rename, overwrite and skip before a byte moves, then undo the whole batch.",
    alt: "360 photos are copied to the other pane with F5. The transfer preview lists each destination with three conflicts set to rename, overwrite and skip. Apply starts a journaled copy with live progress in Operations, and Undo restores all 360 items.",
    segments: [
      { from: ["start", 0.5], to: ["apply", 0.2], cam: [FULL, [["preview", 0.1], 1, 720, 450], [["preview", 0.9], 1.25, 720, 330], [["apply", -0.4], 1.25, 760, 300]] },
      { from: ["ops", -0.1], to: ["ops", 1.6], cam: [[0, 1.3, 720, 450]] },
      { from: ["complete", -0.2], to: ["undone", 1.4], cam: [[0, 1.3, 720, 450], [["undo", -0.4], 1.3, 720, 450], [["undone", 0.4], 1.05, 800, 480]] }
    ],
    poster: ["policies", 0.5]
  },
  {
    id: "large-folder",
    title: "100,000 files, no waiting",
    summary: "A folder with 100,000 entries opens instantly and scrolls without stutter.",
    alt: "Opening Sensor logs, a folder of 100,000 CSV files, shows rows immediately while the full list loads; the pane scrolls smoothly through the listing and End jumps to reading-100000.csv.",
    segments: [
      { from: ["start", 0.5], to: ["end", -0.1], cam: [FULL, [["open", 0.1], 1, 720, 450], [["listed", 1.0], 1.1, 680, 400]] }
    ],
    poster: ["scrolled", 0.3],
    posterOutputSeconds: 3
  },
  {
    id: "search",
    title: "Filtered search",
    summary: "Combine name, size, date and type filters, and get the results in the pane.",
    alt: "The Search dialog is set to files larger than 5 MB modified in the last 7 days under C:\\Demo\\Project files. Six matches appear with their sizes and dates, and closing the dialog leaves them listed in the left pane.",
    segments: [
      { from: ["start", 0.5], to: ["end", -0.1], cam: [FULL, [["dialog", 0.1], 1, 720, 450], [["dialog", 0.8], 1.22, 720, 280], [["filled", 0.2], 1.22, 720, 280], [["results", 0.4], 1.15, 720, 470], [["pane", 0.1], 1.15, 720, 470], [["pane", 0.8], 1.2, 560, 330]] }
    ],
    poster: ["results", 1.0],
    posterOutputSeconds: 6.39
  },
  {
    id: "compare-sync",
    title: "Compare and sync",
    summary: "Compare two folders and preview the sync plan before anything changes.",
    alt: "Compare runs on the Website folders in both panes and marks files only on the left, only on the right and newer on the left. Plan L->R then previews a sync that copies two files and replaces one; nothing is applied.",
    segments: [
      { from: ["start", 0.5], to: ["end", -0.1], cam: [FULL, [["dialog", 0.2], 1, 720, 450], [["compared", 0.2], 1.22, 720, 560], [["planned", -0.3], 1.22, 720, 560], [["planned", 0.5], 1.22, 720, 470]] }
    ],
    poster: ["planned", 1.2],
    posterOutputSeconds: 4.92
  },
  {
    id: "previews",
    title: "Previews, including 3D",
    summary: "Text, images, PDFs and STEP or STL models preview in the side panel.",
    alt: "Selecting files in the left pane updates the preview panel: a README as text, a landscape PNG, a one-page PDF brief, then a STEP bracket assembly rendered in 3D and orbited by dragging.",
    segments: [
      { from: ["start", 0.5], to: ["end", -0.1], cam: [FULL, [["text", -0.6], 1.12, 860, 430], [["model", -0.2], 1.12, 860, 430], [["orbit", -0.3], 1.35, 1060, 520]] }
    ],
    poster: ["orbit", 1.0]
  },
  {
    id: "command-palette",
    title: "Command palette",
    summary: "Ctrl+P finds any of 100+ commands by fuzzy search.",
    alt: "Ctrl+P opens the Command Center; typing split horizontal filters the command list, and Enter stacks the panes top and bottom. A second search, split vertical, puts them back side by side.",
    segments: [
      { from: ["start", 0.5], to: ["end", -0.1], cam: [FULL, [["split", -0.9], 1, 720, 450], [["split", -0.2], 1.3, 720, 250], [["horizontal", -0.2], 1.3, 720, 250], [["horizontal", 0.5], 1, 720, 450], [["vertical", -1.6], 1, 720, 450], [["vertical", -1.1], 1.3, 720, 250], [["vertical", -0.1], 1.3, 720, 250], [["vertical", 0.6], 1, 720, 450]] }
    ],
    poster: ["results", 0.2],
    posterOutputSeconds: 6.3
  },
  {
    id: "safe-rename",
    title: "Safe rename",
    summary: "Rename refuses to overwrite an existing file, and every rename can be undone.",
    alt: "F2 on launch-plan.md and typing README.md is refused with the message that an item named README.md already exists. Renaming to launch-plan-final.md succeeds, and Undo in Operations restores launch-plan.md.",
    segments: [
      { from: ["start", 0.5], to: ["end", -0.1], cam: [FULL, [0.6, 1.2, 620, 560], [["refused", 0.2], 1.12, 900, 640], [["refused", 1.4], 1.12, 900, 640], [["renamed", 0], 1.2, 620, 560], [["ops", -0.2], 1.15, 720, 420], [["restored", 0.2], 1.15, 720, 420], [["restored", 1.0], 1.1, 620, 520]] }
    ],
    poster: ["refused", 1.2]
  },
  {
    id: "keyboard",
    title: "Keyboard-first",
    summary: "Arrow keys, Shift+F10 menus and every dialog work without a mouse, with visible focus.",
    alt: "Arrow keys move a visible focus ring down the file list to budget-2026.xlsx; Shift+F10 opens its context menu, arrows walk the menu to Create Checksums, Enter opens the checksum dialog, and Esc closes it.",
    segments: [
      { from: ["start", 0.5], to: ["end", -0.1], cam: [FULL, [0.4, 1.25, 560, 440], [["menu", 0.1], 1.08, 620, 450], [["enter", 0.1], 1.08, 620, 450], [["enter", 0.8], 1, 720, 450]] }
    ],
    poster: ["menu", 1.4],
    posterOutputSeconds: 5.22,
    keyPlacement: "left"
  },
  {
    id: "ai-handoff",
    title: "Live AI context over MCP",
    summary: "An AI client sees your active pane and can reveal files in it, through a local read-only MCP profile.",
    alt: "A real Codex CLI run through Explore Better's local MCP server with a read-only profile: get_context reads the active pane, search_files finds release-checklist.md, and show_in_explore_better opens 04 Launch in the left pane with the file selected. Model thinking time is trimmed and labelled.",
    segments: [
      { from: ["ask", -0.6], to: ["ask", 0.9], cam: [FULL] },
      { from: ["get-context-start", -0.5], to: ["get-context-start", 0.9], cam: [FULL] },
      { from: ["search-files-start", -0.5], to: ["search-files-start", 0.9], cam: [FULL] },
      { from: ["show-in-explore-better-start", -0.4], to: ["show-in-explore-better-start", 3.2], cam: [FULL, [["show-in-explore-better-start", 0.4], 1, 720, 450], [["show-in-explore-better-start", 1.6], 1.12, 560, 330]] }
    ],
    poster: ["show-in-explore-better-start", 2.4],
    ai: true
  },
  {
    id: "ai-profile",
    title: "Scoped AI access",
    summary: "Each AI client gets a profile: its folders, its tools, and an audit log of every call.",
    alt: "In Preferences, the AI Bridge profile Project files - read only is authorized for C:\\Demo\\Project files only, its tool permissions show read tools enabled and write tools off, and the audit history lists the get_context, search_files and show_in_explore_better calls.",
    segments: [
      { from: ["profile", -1.6], to: ["end", -0.1], cam: [FULL, [["profile", -0.2], 1.25, 720, 360], [["tools", 0.1], 1.25, 720, 360], [["tools", 0.9], 1.2, 720, 480], [["audit", -0.6], 1.2, 720, 480], [["audit", 0.3], 1.35, 720, 400]] }
    ],
    poster: ["audit", 1.0]
  }
];

export function buildFeatureEdit(plan, capture) {
  const markers = new Map(capture.markers.map((marker) => [marker.id, marker.seconds]));
  const at = ([id, offset]) => {
    if (!markers.has(id)) throw new Error(`${plan.id}: capture marker "${id}" is missing; re-run npm run capture:features.`);
    return markers.get(id) + offset;
  };
  const resolve = (value, axis) => {
    if (typeof value !== "string") return value;
    const rect = capture.rects?.[value.replace(/^rect:/, "")];
    if (!rect) throw new Error(`${plan.id}: rect ${value} is missing.`);
    return axis === "x" ? rect.x + rect.width / 2 : rect.y + rect.height / 2;
  };
  const segments = [];
  let cursor = 0;
  for (const segment of plan.segments) {
    const start = at(segment.from);
    const end = Math.min(at(segment.to), capture.durationSeconds - 0.05);
    const duration = Math.round((end - start) * FPS);
    if (duration < 12) throw new Error(`${plan.id}: segment ${segment.from} is too short (${duration} frames).`);
    segments.push({
      from: cursor,
      duration,
      sourceStart: Math.round(start * FPS),
      sourceSeconds: [Number(start.toFixed(3)), Number(end.toFixed(3))],
      cam: segment.cam
        .map(([t, s, x, y]) => ({ f: Math.max(0, Math.round((Array.isArray(t) ? at(t) - start : t) * FPS)), s, x: resolve(x, "x"), y: resolve(y, "y") }))
        .sort((a, b) => a.f - b.f)
    });
    cursor += duration;
  }
  // Ease the camera back to the opening framing just before the loop dissolve, so the
  // dissolve only blends content, never two different zoom levels.
  const loopFrames = Math.min(12, segments[0].sourceStart);
  const last = segments.at(-1);
  const home = segments[0].cam[0];
  const settleAt = last.duration - loopFrames;
  const holdAt = Math.max(0, settleAt - 24);
  const camAt = (cam, f) => {
    let previous = cam[0];
    for (const key of cam) {
      if (key.f > f) {
        const t = (f - previous.f) / Math.max(1, key.f - previous.f);
        return { s: previous.s + (key.s - previous.s) * t, x: previous.x + (key.x - previous.x) * t, y: previous.y + (key.y - previous.y) * t };
      }
      previous = key;
    }
    return previous;
  };
  const held = camAt(last.cam, holdAt);
  last.cam = [...last.cam.filter((key) => key.f < holdAt), { ...held, f: holdAt }, { f: settleAt, s: home.s, x: home.x, y: home.y }];
  const toOutput = (seconds) => {
    for (const segment of segments) {
      const offset = seconds * FPS - segment.sourceStart;
      if (offset >= 0 && offset < segment.duration) return segment.from + Math.round(offset);
    }
    return null;
  };
  const keys = [];
  for (const key of capture.keys || []) {
    const frame = toOutput(key.seconds);
    if (frame === null) continue;
    const previous = keys.at(-1);
    if (previous && previous.label === key.label && frame - previous.lastFrame < 20) {
      previous.count += 1;
      previous.lastFrame = frame;
      continue;
    }
    keys.push({ label: key.label, from: frame, lastFrame: frame, count: 1 });
  }
  const labels = [];
  let ai = null;
  if (plan.ai) {
    const rows = (capture.aiEvents || [])
      .filter((event) => event.phase === "complete")
      .map((event) => ({ tool: event.tool, detail: event.detail || "", at: toOutput(event.seconds) }))
      .filter((row) => row.at !== null);
    if (rows.length < 3) throw new Error(`${plan.id}: expected three recorded MCP calls in the edit, found ${rows.length}.`);
    const sourceSpan = segments.at(-1).sourceSeconds[1] - segments[0].sourceSeconds[0];
    const trimmedSeconds = Math.round(sourceSpan - cursor / FPS);
    const client = /codex/i.test(capture.aiClient || "") ? "Codex CLI" : "MCP client";
    ai = { client, from: 0, duration: cursor, task: "Find the release checklist and reveal it in my active pane.", rows, trimmedSeconds };
    labels.push({ text: `REAL ${client.toUpperCase()} RUN / ${trimmedSeconds} S OF MODEL WAIT TRIMMED`, from: 6, duration: cursor - 6 });
  }
  // posterOutputSeconds pins the poster to a reviewed moment of the finished clip.
  const posterFrame = Number.isFinite(plan.posterOutputSeconds) ? Math.round(plan.posterOutputSeconds * FPS) : toOutput(at(plan.poster));
  if (posterFrame === null) throw new Error(`${plan.id}: poster time falls outside the edit.`);
  return {
    id: plan.id,
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    space: SPACE,
    source: `features/${plan.id}.mp4`,
    durationInFrames: cursor,
    segments,
    keys: keys.map(({ label, from, count }) => ({ label: count > 1 ? `${label} ×${count}` : label, from })),
    keyPlacement: plan.keyPlacement || "center",
    labels,
    ai,
    loopFrames,
    posterFrame
  };
}
