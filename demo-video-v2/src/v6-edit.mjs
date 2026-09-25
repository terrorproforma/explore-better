// Edit decision list for the v6 cut. Every clip is addressed relative to a marker the
// capture script recorded, so a fresh `npm run capture` re-times the edit automatically.
// Camera keyframes are [time, scale, centerX, centerY] in the 1920x1080 edit space.

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const CHAPTERS = [
  { id: "open", title: "Overview" },
  { id: "find", title: "Filtered Search" },
  { id: "disk", title: "Exact Disk Map" },
  { id: "transfer", title: "Preview + Copy" },
  { id: "safety", title: "Safe + Keyboard-First" },
  { id: "terminal", title: "Terminal Follows" },
  { id: "ai", title: "Live AI Context" },
  { id: "scope", title: "Scoped AI Access" }
];

function clipPlan() {
  return [
    { id: "open", chapter: "open", from: ["workspace", 0.1], to: ["palette", 0], cam: [[0, 1.07, 960, 540], [2.6, 1.0, 960, 540]] },

    { id: "find-palette", chapter: "find", from: ["palette", -0.05], to: ["search-form", -0.25], cam: [[0, 1.0, 960, 540], [1.8, 1.1, 1000, 470]] },
    { id: "find-filter", chapter: "find", from: ["search-form", 1.25], to: ["search-results", 0.85], cam: [[0, 1.12, 1180, 520], [0.9, 1.34, 1330, 470], [["search-results", -0.3], 1.34, 1330, 470], [["search-results", 0.45], 1.1, 960, 610]] },
    { id: "find-pane", chapter: "find", from: ["search-pane", 0.05], to: ["search-pane", 1.95], cam: [[0, 1.0, 960, 540], [1.9, 1.16, 760, 470]] },

    { id: "disk-palette", chapter: "disk", from: ["disk-palette", 0.02], to: ["disk-scan", -0.1], cam: [[0, 1.0, 960, 540]] },
    { id: "disk-map", chapter: "disk", from: ["disk-map", -1.25], to: ["disk-map", 2.3], cam: [[0, 1.0, 960, 540], [1.2, 1.0, 960, 540], [3.55, 1.1, 820, 660]] },

    { id: "transfer-preview", chapter: "transfer", from: ["transfer-select", 0.35], to: ["transfer-preview", 1.85], cam: [[0, 1.0, 960, 540], [2.0, 1.0, 960, 540], [3.3, 1.13, 960, 380]] },
    { id: "transfer-apply", chapter: "transfer", from: ["transfer-apply", -0.75], to: ["transfer-apply", 0.1], cam: [[0, 1.13, 960, 380], [0.85, 1.16, 1300, 300]] },
    { id: "transfer-progress", chapter: "transfer", from: ["ops-open", -0.05], to: ["ops-complete", 1.7], cam: [[0, 1.06, 960, 470], [["ops-complete", 0.05], 1.06, 960, 470], [["ops-complete", 0.75], 1.2, 1110, 560]] },

    { id: "rename", chapter: "safety", from: ["rename", 0.3], to: ["rename-refused", 1.75], cam: [[0, 1.0, 960, 540], [["rename-refused", -0.25], 1.08, 900, 640], [["rename-refused", 0.5], 1.2, 1120, 630]] },
    { id: "keyboard", chapter: "safety", from: ["keyboard", -0.1], to: ["keyboard", 2.95], cam: [[0, 1.12, 700, 560], [3.0, 1.2, 700, 470]] },

    { id: "terminal-open", chapter: "terminal", from: ["terminal", 0.3], to: ["terminal", 2.85], cam: [[0, 1.0, 960, 540], [1.0, 1.22, 700, 700], [2.55, 1.24, 700, 700]] },
    { id: "terminal-follow", chapter: "terminal", from: ["terminal-follow", 0.1], to: ["terminal-follow", 5.35], cam: [[0, 1.2, 700, 620], [1.3, 1.2, 700, 620], [5.25, 1.28, 700, 720]] },

    { id: "ai-ask", chapter: "ai", from: ["ai-handoff", 0.2], to: ["ai-handoff", 1.4], cam: [[0, 1.0, 960, 540]], flash: false },
    { id: "ai-context", chapter: "ai", from: ["ai-get-context-start", -0.45], to: ["ai-get-context-start", 0.55], cam: [[0, 1.0, 960, 540]], flash: false },
    { id: "ai-search", chapter: "ai", from: ["ai-search-files-start", -0.35], to: ["ai-search-files-start", 0.65], cam: [[0, 1.0, 960, 540]], flash: false },
    { id: "ai-reveal", chapter: "ai", from: ["ai-show-in-explore-better-start", -0.3], to: ["ai-show-in-explore-better-start", 2.7], cam: [[0, 1.0, 960, 540], [0.6, 1.0, 960, 540], [3.0, 1.05, 820, 480]], flash: false },

    { id: "scope-profile", chapter: "scope", from: ["ai-bridge-profile", -0.5], to: ["ai-bridge-profile", 1.9], cam: [[0, 1.0, 960, 540], [2.4, 1.16, 960, 470]] },
    { id: "scope-audit", chapter: "scope", from: ["ai-bridge-profile", 2.15], to: ["ai-audit", 2.2], cam: [[0, 1.0, 960, 540], [["ai-audit", -0.6], 1.0, 960, 540], [["ai-audit", 0.4], 1.22, 960, 560], [["ai-audit", 1.9], 1.24, 960, 560]] },

    // The end card sits over the idle opening workspace, slowed slightly behind the dim.
    { id: "end", chapter: "end", from: ["workspace", 0.1], to: ["palette", -0.05], rate: 0.78, cam: [[0, 1.0, 960, 540], [3.3, 1.05, 960, 540]], flash: false }
  ];
}

export function captionPlan(texts, aiClient) {
  const copied = /(\d+)\s*copied/i.exec(texts.opsDoneMeta || "")?.[1];
  const took = /(\d+(?:\.\d+)?\s*s)\s*total/i.exec(texts.opsDoneMeta || "")?.[1]?.replace(/\s+/g, "");
  const matches = /(\d+)\s*match/i.exec(texts.searchSummary || "")?.[1];
  const renames = /rename:\s*(\d+)/i.exec(texts.transferSummary || "")?.[1];
  const client = /codex/i.test(aiClient || "") ? "CODEX CLI" : "MCP CLIENT";
  return [
    { clip: "find-palette", until: "find-pane", position: "bottomRight", eyebrow: "01 / Filtered search", headline: "Find every big file in one query.", proof: ["SIZE + DATE FILTERS", matches ? `${matches} MATCHES > 5 MB` : "RESULTS IN THE PANE"] },
    { clip: "disk-palette", until: "disk-map", position: "topRight", eyebrow: "02 / Disk map", headline: "See what is eating the drive.", proof: ["EXACT ALLOCATION", "HARDLINKS COUNTED ONCE"] },
    { clip: "transfer-preview", until: "transfer-apply", position: "transfer", eyebrow: "03 / Transfer preview", headline: "Know what happens before a byte moves.", detail: "Every destination, rename and conflict is listed before you apply.", proof: [renames ? `${renames} CONFLICTS RENAMED, NOT REPLACED` : "CONFLICTS CAUGHT FIRST"] },
    { clip: "transfer-progress", position: "transfer", eyebrow: "03 / Transactional copy", headline: "Then watch every file land.", detail: "Live progress while it runs. One click undoes the whole batch.", proof: [copied && took ? `${copied} FILES IN ${took.replace(/s$/i, " S")}` : "LIVE PROGRESS", "JOURNALED", "UNDOABLE"], settleOn: "ops-complete" },
    { clip: "rename", position: "topRight", eyebrow: "04 / Safe rename", headline: "Rename can never overwrite your work.", proof: ["REFUSES EXISTING NAMES"] },
    { clip: "keyboard", position: "topRight", eyebrow: "05 / Keyboard-first", headline: "Every menu works from the keyboard.", proof: ["SHIFT + F10", "VISIBLE FOCUS"] },
    { clip: "terminal-open", until: "terminal-follow", position: "topRight", eyebrow: "06 / Terminal", headline: "A shell that follows your folder.", proof: ["PER FILE TAB", "NO BACKEND SECRETS INHERITED"] },
    { clip: "ai-ask", until: "ai-reveal", position: "bottomLeft", eyebrow: "07 / Live AI context", headline: "Your AI sees the pane you see.", proof: [`${client} + LOCAL MCP`, "READ-ONLY PROFILE"] },
    { clip: "scope-profile", until: "scope-audit", position: "bottomRight", eyebrow: "08 / Scoped AI access", headline: "Only the folders you allow. Every call audited.", proof: ["SCOPED ROOTS", "NO PERMANENT DELETE", "STARTUP + CLIENT CONFIG WRITES REFUSED"] }
  ];
}

export function buildV6Edit(manifest, trace = null) {
  const markers = new Map(manifest.markers.map((marker) => [marker.id, marker.seconds]));
  const at = ([id, offset]) => {
    if (!markers.has(id)) throw new Error(`Capture marker "${id}" is missing; re-run npm run capture.`);
    return markers.get(id) + offset;
  };
  const clips = [];
  let cursor = 0;
  for (const plan of clipPlan()) {
    const start = at(plan.from);
    const end = at(plan.to);
    const rate = plan.rate || 1;
    const duration = Math.round(((end - start) * FPS) / rate);
    if (duration < 12) throw new Error(`Clip ${plan.id} is too short (${duration} frames).`);
    clips.push({
      id: plan.id,
      chapter: plan.chapter,
      from: cursor,
      duration,
      sourceStart: Math.round(start * FPS),
      sourceSeconds: [Number(start.toFixed(3)), Number(end.toFixed(3))],
      rate,
      // A keyframe time is seconds into the clip, or [marker, offset] for moments whose
      // position inside the clip depends on real app timing.
      cam: plan.cam
        .map(([t, s, x, y]) => ({ f: Math.max(0, Math.round((Array.isArray(t) ? at(t) - start : t) * FPS)), s, x, y }))
        .sort((a, b) => a.f - b.f),
      flash: plan.flash !== false
    });
    cursor += duration;
  }
  const durationInFrames = cursor;
  const clipById = new Map(clips.map((clip) => [clip.id, clip]));
  // Maps a source time to the output frame, if that moment survives the edit.
  const toOutput = (seconds) => {
    for (const clip of clips) {
      if (clip.rate !== 1) continue;
      const offset = seconds * FPS - clip.sourceStart;
      if (offset >= 0 && offset < clip.duration) return clip.from + Math.round(offset);
    }
    return null;
  };

  const chapters = CHAPTERS.map((chapter) => {
    const members = clips.filter((clip) => clip.chapter === chapter.id);
    return { ...chapter, startFrame: members[0].from, endFrame: members.at(-1).from + members.at(-1).duration };
  });

  const captions = captionPlan(manifest.texts || {}, manifest.aiClient).map((caption) => {
    const first = clipById.get(caption.clip);
    const last = clipById.get(caption.until || caption.clip);
    const settle = caption.settleOn ? toOutput(markers.get(caption.settleOn)) : null;
    return {
      ...caption,
      from: first.from,
      duration: last.from + last.duration - first.from,
      settleAt: settle === null ? null : settle - first.from
    };
  });

  const skipKeys = new Set(["Backspace"]);
  const keys = [];
  for (const key of manifest.keys || []) {
    if (skipKeys.has(key.label)) continue;
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

  const aiRows = (manifest.aiEvents || [])
    .filter((event) => event.phase === "complete")
    .map((event) => ({ tool: event.tool, detail: event.detail || "", at: toOutput(event.seconds) }))
    .filter((row) => row.at !== null);
  const aiStart = clipById.get("ai-ask");
  const aiEnd = clipById.get("ai-reveal");
  // Everything between the prompt and the reveal that the edit drops (model thinking and
  // the pauses between calls) is reported on screen.
  const aiSourceSpan = aiEnd.sourceSeconds[1] - aiStart.sourceSeconds[0];
  const trimmed = Math.max(0, aiSourceSpan - (aiEnd.from + aiEnd.duration - aiStart.from) / FPS);
  const ai = {
    client: /codex/i.test(manifest.aiClient || "") ? "Codex CLI" : "MCP client",
    from: aiStart.from,
    duration: aiEnd.from + aiEnd.duration - aiStart.from,
    task: "Find the release checklist and reveal it in my active pane.",
    rows: aiRows,
    trimmedSeconds: Math.round(trimmed)
  };

  const endClip = clipById.get("end");
  const seconds = (frame) => Number((frame / FPS).toFixed(2));
  const chapterStart = (id) => seconds(chapters.find((chapter) => chapter.id === id).startFrame);
  const score = {
    duration: durationInFrames / FPS,
    sectionPoints: {
      human: chapterStart("find"),
      command: chapterStart("find") + 0.01,
      disk: chapterStart("disk"),
      safety: chapterStart("transfer"),
      terminal: seconds(clipById.get("transfer-progress").from),
      ai: chapterStart("ai"),
      proof: chapterStart("scope"),
      final: seconds(endClip.from),
      end: durationInFrames / FPS
    },
    cueTimes: [
      0.1,
      ...chapters.slice(1).map((chapter) => seconds(chapter.startFrame)),
      seconds(clipById.get("find-pane").from),
      seconds(clipById.get("disk-map").from + Math.round(1.25 * FPS)),
      ...[toOutput(markers.get("ops-complete")), toOutput(markers.get("rename-refused")), toOutput(markers.get("ai-show-in-explore-better-complete")), toOutput(markers.get("ai-audit"))]
        .filter((frame) => frame !== null).map(seconds),
      seconds(endClip.from)
    ].sort((a, b) => a - b)
  };

  return {
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    durationInFrames,
    sourceSize: manifest.resolution,
    clips,
    chapters,
    captions,
    keys: keys.map(({ label, from, count }) => ({ label: count > 1 ? `${label} ×${count}` : label, from })),
    ai,
    endFrom: endClip.from,
    score,
    trace: trace ? { client: trace.client } : null
  };
}
