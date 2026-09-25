// Edit decision list for the v7 cut: the v6 story, re-cut so the picture follows the score.
//
// The chapter cuts come from the music's beat map (they already sit on downbeats), so every
// chapter has a fixed length. Inside a chapter, each clip's footage is retimed with a
// piecewise-linear time map whose anchors pin real on-screen moments (a key press opening a
// dialog, results landing, a toast) to beats, bar lines and strong hits. A small dynamic
// program picks the grid position for every anchor so that playback speed stays between
// MIN_RATE and MAX_RATE and each moment moves as little as possible from where the
// recording naturally puts it. A re-score only needs a new beat map; a fresh capture only
// needs new markers. Neither needs hand-tuned times.

import { CHAPTERS, captionPlan, FPS, WIDTH, HEIGHT } from "./v6-edit.mjs";

export { FPS, WIDTH, HEIGHT };

// Playback speed limits for retimed footage. Above ~2.5x cursor moves and typing start to
// read as fast-forward; below 0.5x a 30 fps screen recording starts to show held frames.
export const MIN_RATE = 0.5;
export const MAX_RATE = 2.5;
// Anchors never sit closer than this many frames to each other or to a cut.
const MIN_GAP_FRAMES = 4;

// How much a hit kind counts as an accent. Stops and risers mark silence or build-ups, not
// moments to land on, so they carry no weight.
const KIND_WEIGHT = { drop: 1, impact: 1, stab: 0.9, "kick-accent": 0.7, "lead-in": 0.4, clap: 0.3 };

// ---------------------------------------------------------------------------------------
// Music grid and quantization helpers.

export function createMusicGrid(beatmap) {
  const beats = [...beatmap.beats].sort((a, b) => a - b);
  const bars = [...beatmap.bars].sort((a, b) => a - b);
  const moments = [];
  for (const hit of [...beatmap.hits].sort((a, b) => a.time - b.time)) {
    let moment = moments.at(-1);
    if (!moment || Math.abs(moment.time - hit.time) > 0.002) {
      moment = { time: hit.time, kinds: [], strength: 0, score: 0 };
      moments.push(moment);
    }
    moment.kinds.push(hit.kind);
    moment.strength = Math.max(moment.strength, hit.strength);
    moment.score = Math.max(moment.score, hit.strength * (KIND_WEIGHT[hit.kind] ?? 0));
  }
  const sections = beatmap.sections;
  const tempo = [...beatmap.tempoMap].sort((a, b) => a.time - b.time);
  const near = (a, b) => Math.abs(a - b) < 0.002;
  const momentAt = (time) => moments.find((moment) => near(moment.time, time)) || null;
  const sectionAt = (time) => sections.find((section) => time >= section.start - 1e-6 && time < section.end - 1e-6) || sections.at(-1);
  const beatLength = (time) => {
    const entry = [...tempo].reverse().find((item) => item.time <= time + 1e-6 && item.bpm);
    return 60 / (entry?.bpm || 120);
  };
  const stops = moments.filter((moment) => moment.kinds.includes("stop")).map((moment) => moment.time);

  const describe = (time, fallback) => {
    const moment = momentAt(time);
    return { time, kinds: moment ? moment.kinds : [fallback], score: moment ? moment.score : 0, strength: moment ? moment.strength : 0 };
  };

  // Grid positions of one type between two times (inclusive). Types:
  //   beat | bar | accent (any weighted hit) | strongest (same set; the solver ranks by
  //   score) | hit:<kind>[|<kind>...]
  function candidates(type, from = -Infinity, to = Infinity) {
    const inRange = (time) => time >= from - 1e-6 && time <= to + 1e-6;
    if (type === "beat") return beats.filter(inRange).map((time) => describe(time, "beat"));
    if (type === "bar") return bars.filter(inRange).map((time) => describe(time, "bar"));
    if (type === "accent" || type === "strongest") {
      return moments.filter((moment) => inRange(moment.time) && moment.score >= 0.3 && !moment.kinds.includes("stop")).map((moment) => ({ ...moment }));
    }
    if (type.startsWith("hit:")) {
      const kinds = type.slice(4).split("|");
      return moments.filter((moment) => inRange(moment.time) && moment.kinds.some((kind) => kinds.includes(kind))).map((moment) => ({ ...moment }));
    }
    throw new Error(`Unknown grid type "${type}".`);
  }

  // snap(time, "beat" | "bar" | "hit:<kind>" | "accent") -> nearest grid time.
  function snap(time, type = "beat", window = Infinity) {
    let best = null;
    for (const candidate of candidates(type, time - window, time + window)) {
      if (!best || Math.abs(candidate.time - time) < Math.abs(best.time - time)) best = candidate;
    }
    return best ? best.time : time;
  }

  // The strongest accent within `window` seconds of `time`, or null.
  function nearestStrongHit(time, window = 0.25, minScore = 0.45) {
    let best = null;
    for (const moment of candidates("accent", time - window, time + window)) {
      if (moment.score < minScore) continue;
      if (!best || moment.score > best.score + 1e-9 || (Math.abs(moment.score - best.score) < 1e-9 && Math.abs(moment.time - time) < Math.abs(best.time - time))) best = moment;
    }
    return best;
  }

  // Beat `count` steps after (or before, if negative) the beat nearest `time`.
  function beatFrom(time, count) {
    let index = 0;
    for (let i = 0; i < beats.length; i += 1) if (Math.abs(beats[i] - time) < Math.abs(beats[index] - time)) index = i;
    return beats[Math.max(0, Math.min(beats.length - 1, index + count))];
  }

  const nextBar = (time) => bars.find((bar) => bar > time + 1e-3) ?? time;
  const previousBar = (time) => [...bars].reverse().find((bar) => bar < time - 1e-3) ?? time;

  // The nearest beat or hit to a time, used by the sync report.
  function nearestGridPoint(time) {
    let best = null;
    const consider = (candidate, kind) => {
      if (!best || Math.abs(candidate - time) < Math.abs(best.time - time)) best = { time: candidate, kind };
    };
    for (const beat of beats) consider(beat, "beat");
    for (const moment of moments) if (moment.score >= 0.3) consider(moment.time, moment.kinds.join("+"));
    return best;
  }

  return { beats, bars, moments, sections, stops, sectionAt, beatLength, momentAt, candidates, snap, nearestStrongHit, beatFrom, nextBar, previousBar, nearestGridPoint, duration: beatmap.durationSeconds };
}

// ---------------------------------------------------------------------------------------
// Visual change index: the capture's per-frame luminance difference (see render-v7.mjs).
// A marker is logged when the script acts; the pixels change a few frames later. Anchoring
// the frame where the screen actually changes makes the change itself land on the beat.

// `pick: "last"` takes the last big change in the window instead of the biggest, for UI that
// opens in a loading state and then draws its content.
export function createVisualIndex(motion) {
  return (seconds, { before = 0.15, after = 0.5, min = 0.8, pick = "max" } = {}) => {
    if (!motion?.diffs?.length) return seconds;
    const fps = motion.fps || FPS;
    const first = Math.max(1, Math.floor((seconds - before) * fps));
    const last = Math.min(motion.diffs.length - 1, Math.ceil((seconds + after) * fps));
    let best = -1;
    let bestValue = min;
    for (let frame = first; frame <= last; frame += 1) {
      if (pick === "last" ? motion.diffs[frame] > min : motion.diffs[frame] > bestValue) {
        bestValue = motion.diffs[frame];
        best = frame;
      }
    }
    return best < 0 ? seconds : best / fps;
  };
}

// ---------------------------------------------------------------------------------------
// The plan. Clip sources are [marker, offset]. Sync points pin a source moment to a grid
// type; `keycap` shows a keycap on that frame, `reveal` marks the chapter's payoff (it
// gets a small scale punch outside the breakdown). Cuts between clips land on `cutOn`
// (default "beat"). Camera keyframes are written in output seconds through `ctx`, so a
// push starts on a bar line and peaks on the accent it is aimed at.

function chapterPlans() {
  return {
    open: {
      clips: [{ id: "open", from: ["workspace", 0.1], to: ["palette", -0.45] }],
      syncs: [],
      cam: (c) => ({ open: [[c.start, 1.07, 960, 540], [c.end, 1.0, 960, 540]] })
    },

    find: {
      clips: [{ id: "find-palette", from: ["palette", -0.45], to: ["search-results", 0.8] }],
      syncs: [
        { id: "find-ctrlp", src: { key: "Ctrl + P", after: "palette", visual: true }, to: "beat", keycap: "Ctrl + P" },
        { id: "find-enter", src: { key: "Enter", after: "palette", visual: true }, to: "beat", keycap: "Enter" },
        { id: "find-kind", src: { click: "#search-kind" }, to: "beat" },
        { id: "find-size", src: { click: "#search-size-op" }, to: "beat" },
        { id: "find-value", src: { click: "#search-size-value" }, to: "beat" },
        { id: "find-results", src: { marker: "search-results", visual: { before: 0.4, after: 0.2 } }, to: "strongest", reveal: true, label: "Search results land" }
      ],
      cam: (c) => ({
        "find-palette": [
          [c.start, 1.0, 960, 540],
          [c.t("find-enter"), 1.1, 1000, 470],
          [c.t("find-kind"), 1.22, 1180, 520],
          [c.t("find-size"), 1.34, 1330, 470],
          [c.beatFrom(c.t("find-results"), -1), 1.34, 1330, 470],
          [c.t("find-results"), 1.1, 960, 610],
          [c.motionEnd, 1.13, 960, 600]
        ]
      })
    },

    disk: {
      clips: [{ id: "disk-palette", from: ["disk-palette", -0.25], to: ["disk-map", 0.4] }],
      syncs: [
        { id: "disk-ctrlp", src: { key: "Ctrl + P", after: "disk-palette", visual: true }, to: "beat", keycap: "Ctrl + P" },
        // The analyzer opens in a scanning state and draws the treemap a few frames later;
        // the treemap is the payoff, so it takes the hit.
        { id: "disk-map", src: { key: "Enter", after: "disk-palette", visual: { before: 0, after: 0.4, min: 20, pick: "last" } }, to: "strongest", keycap: "Enter", reveal: true, label: "Disk map appears" },
        { id: "disk-scan", src: { click: "scan" }, to: "beat" },
        { id: "disk-view", src: { click: "view-map" }, to: "beat" }
      ],
      cam: (c) => ({
        "disk-palette": [
          [c.start, 1.0, 960, 540],
          [c.t("disk-map"), 1.0, 960, 540],
          [c.nextBar(c.t("disk-map")), 1.1, 820, 660],
          [c.motionEnd, 1.12, 810, 670]
        ]
      })
    },

    transfer: {
      clips: [
        { id: "transfer-preview", from: ["transfer-select", 0.05], to: ["transfer-preview", 1.9] },
        { id: "transfer-apply", from: ["transfer-apply", -0.75], to: ["transfer-apply", 0.1] },
        { id: "transfer-progress", from: ["ops-open", -0.05], to: ["ops-complete", 1.6], cutOn: "bar" }
      ],
      syncs: [
        { id: "transfer-open", src: { click: "row", after: "transfer-select" }, to: "beat" },
        { id: "transfer-ctrla", src: { key: "Ctrl + A", after: "transfer-select", visual: true }, to: "beat", keycap: "Ctrl + A" },
        { id: "transfer-f5", src: { key: "F5", after: "transfer-select", visual: true }, to: "accent", keycap: "F5", label: "Transfer preview opens" },
        { id: "transfer-apply", src: { click: "#transfer-apply" }, to: "accent", label: "Apply" },
        { id: "transfer-complete", src: { marker: "ops-complete", visual: { before: 0.2, after: 0.3 } }, to: "strongest", reveal: true, label: "Copy completes" }
      ],
      cam: (c) => ({
        "transfer-preview": [
          [c.clipStart("transfer-preview"), 1.0, 960, 540],
          [c.t("transfer-f5"), 1.0, 960, 540],
          [c.beatFrom(c.t("transfer-f5"), 2), 1.13, 960, 380]
        ],
        "transfer-apply": [
          [c.clipStart("transfer-apply"), 1.13, 960, 380],
          [c.t("transfer-apply"), 1.16, 1300, 300]
        ],
        "transfer-progress": [
          [c.clipStart("transfer-progress"), 1.06, 960, 470],
          [c.t("transfer-complete"), 1.06, 960, 470],
          [c.beatFrom(c.t("transfer-complete"), 2), 1.2, 1110, 560]
        ]
      })
    },

    safety: {
      clips: [
        { id: "rename", from: ["rename", 0.3], to: ["rename-refused", 0.9] },
        { id: "keyboard", from: ["keyboard", -0.4], to: ["keyboard", 2.95], cutOn: "bar" }
      ],
      syncs: [
        { id: "safety-f2", src: { key: "F2", after: "rename", visual: true }, to: "beat", keycap: "F2" },
        { id: "safety-refused", src: { marker: "rename-refused", visual: { before: 0.1, after: 0.3, min: 0.5 } }, to: "strongest", keycap: "Enter", reveal: true, label: "Rename refused" },
        { id: "safety-down-1", src: { key: "↓", after: "keyboard", index: 0, visual: { before: 0, after: 0.2, min: 0.2 } }, to: "beat", keycap: "↓" },
        { id: "safety-menu", src: { key: "Shift + F10", after: "keyboard", visual: true }, to: "beat", keycap: "Shift + F10", label: "Context menu opens" },
        { id: "safety-down-2", src: { key: "↓", after: "menu-open", index: 0, visual: { before: 0, after: 0.2, min: 0.2 } }, to: "beat", keycap: "↓" },
        { id: "safety-down-3", src: { key: "↓", after: "menu-open", index: 1, visual: { before: 0, after: 0.2, min: 0.2 } }, to: "beat", keycap: "↓" },
        { id: "safety-down-4", src: { key: "↓", after: "menu-open", index: 2, visual: { before: 0, after: 0.2, min: 0.2 } }, to: "beat", keycap: "↓" },
        { id: "safety-down-5", src: { key: "↓", after: "menu-open", index: 3, visual: { before: 0, after: 0.2, min: 0.2 } }, to: "beat", keycap: "↓" }
      ],
      cam: (c) => ({
        rename: [
          [c.clipStart("rename"), 1.0, 960, 540],
          [c.beatFrom(c.t("safety-refused"), -2), 1.08, 900, 640],
          [c.t("safety-refused"), 1.2, 1120, 630]
        ],
        keyboard: [
          [c.clipStart("keyboard"), 1.12, 700, 560],
          [c.clipEnd("keyboard"), 1.2, 700, 470]
        ]
      })
    },

    terminal: {
      clips: [
        { id: "terminal-open", from: ["terminal", 0.2], to: ["terminal-enter", 0.55] },
        { id: "terminal-follow", from: ["terminal-follow", 0.1], to: ["terminal-cat", 1.7] }
      ],
      syncs: [
        { id: "terminal-toggle", src: { click: "terminal-toggle", after: "terminal", visual: { before: 0, after: 0.3, min: 5 } }, to: "beat", label: "Terminal opens" },
        { id: "terminal-enter", src: { marker: "terminal-enter", visual: { before: 0, after: 0.4, min: 0.2 } }, to: "accent" },
        { id: "terminal-cd", src: { marker: "terminal-cd", visual: { before: 0.3, after: 0.3 } }, to: "strongest", reveal: true, label: "Pane and shell move to 04 Launch" },
        { id: "terminal-cat", src: { marker: "terminal-cat", visual: { before: 0, after: 0.4, min: 0.2 } }, to: "accent", label: "Checklist prints" }
      ],
      cam: (c) => ({
        "terminal-open": [
          [c.clipStart("terminal-open"), 1.0, 960, 540],
          [c.t("terminal-toggle"), 1.0, 960, 540],
          [c.t("terminal-enter"), 1.22, 700, 700],
          [c.clipEnd("terminal-open"), 1.24, 700, 700]
        ],
        "terminal-follow": [
          [c.clipStart("terminal-follow"), 1.2, 700, 620],
          [c.t("terminal-cd"), 1.2, 700, 620],
          [c.motionEnd, 1.28, 700, 720]
        ]
      })
    },

    ai: {
      clips: [
        { id: "ai-ask", from: ["ai-handoff", 0.2], to: ["ai-handoff", 1.4], flash: false },
        { id: "ai-context", from: ["ai-get-context-start", -0.45], to: ["ai-get-context-start", 0.55], flash: false },
        { id: "ai-search", from: ["ai-search-files-start", -0.35], to: ["ai-search-files-start", 0.65], flash: false },
        { id: "ai-reveal", from: ["ai-show-in-explore-better-start", -0.3], to: ["ai-show-in-explore-better-start", 2.7], flash: false }
      ],
      syncs: [
        { id: "ai-row-get_context", src: { ai: "get_context" }, to: "beat", label: "get_context row" },
        { id: "ai-row-search_files", src: { ai: "search_files" }, to: "beat", label: "search_files row" },
        { id: "ai-reveal", src: { ai: "show_in_explore_better", visual: { before: 0.05, after: 0.4 } }, to: "strongest", reveal: true, label: "Pane reveals the file" }
      ],
      cam: (c) => ({
        "ai-reveal": [
          [c.clipStart("ai-reveal"), 1.0, 960, 540],
          [c.t("ai-reveal"), 1.0, 960, 540],
          [c.motionEnd, 1.05, 820, 480]
        ]
      })
    },

    scope: {
      clips: [
        { id: "scope-profile", from: ["ai-bridge-profile", -0.5], to: ["ai-bridge-profile", 1.9] },
        // Starts only once the settings filter has hidden the dev-build client snippet (it
        // shows repository paths while "audit" is half typed). Older captures lack the
        // marker, so fall back to the last big screen change after the search click.
        {
          id: "scope-audit",
          from: { marker: "preferences-filtered", offset: 0.05, fallback: { click: "#preferences-search", visual: { before: 0, after: 1.4, min: 20, pick: "last" }, offset: 0.1 } },
          to: ["end", -0.2]
        }
      ],
      syncs: [
        { id: "scope-audit", src: { marker: "ai-audit", visual: { before: 0.7, after: 0 } }, to: "strongest", reveal: true, label: "Audit log opens" }
      ],
      cam: (c) => ({
        "scope-profile": [
          [c.clipStart("scope-profile"), 1.0, 960, 540],
          [c.clipEnd("scope-profile"), 1.16, 960, 470]
        ],
        "scope-audit": [
          [c.clipStart("scope-audit"), 1.0, 960, 540],
          [c.t("scope-audit"), 1.0, 960, 540],
          [c.nextBar(c.t("scope-audit")), 1.22, 960, 560],
          [c.end, 1.26, 960, 560]
        ]
      })
    },

    // The end card sits over the idle opening workspace, slowed behind the dim.
    end: {
      clips: [{ id: "end", from: ["workspace", 0.1], to: ["palette", -0.25], flash: false }],
      syncs: [],
      cam: (c) => ({ end: [[c.start, 1.0, 960, 540], [c.end, 1.05, 960, 540]] })
    }
  };
}

// ---------------------------------------------------------------------------------------
// Anchor solver.

function solveAnchors({ points, U, startFrame, endFrame, grid, chapterId }) {
  const T0 = startFrame / FPS;
  const T1 = endFrame / FPS;
  const natural = (u) => T0 + (u / U) * (T1 - T0);
  const layers = points.map((point) => {
    let list = grid.candidates(point.to, T0, T1);
    list = list
      .map((candidate) => ({ ...candidate, frame: Math.round(candidate.time * FPS) }))
      .filter((candidate) => candidate.frame >= startFrame + MIN_GAP_FRAMES && candidate.frame <= endFrame - MIN_GAP_FRAMES);
    const topScore = Math.max(0, ...list.map((candidate) => candidate.score));
    return list.map((candidate) => {
      let cost = Math.abs(candidate.time - natural(point.u));
      // "strongest" strongly prefers the chapter's highest-scoring accent.
      if (point.to === "strongest") cost += 14 * (topScore - candidate.score);
      if (point.to === "accent") cost -= 0.4 * candidate.score;
      return { ...candidate, cost };
    });
  });
  const segmentCost = (du, dFrames) => {
    if (dFrames < MIN_GAP_FRAMES) return Infinity;
    const rate = (du * FPS) / dFrames;
    if (rate < MIN_RATE || rate > MAX_RATE) return Infinity;
    return 0.35 * (dFrames / FPS) * Math.abs(Math.log(rate));
  };
  // best[i][j]: cheapest way to place points 0..i with point i on candidate j.
  const best = layers.map((layer) => layer.map(() => ({ cost: Infinity, from: -1 })));
  for (let i = 0; i < points.length; i += 1) {
    layers[i].forEach((candidate, j) => {
      if (i === 0) {
        const cost = candidate.cost + segmentCost(points[0].u, candidate.frame - startFrame);
        best[0][j] = { cost, from: -1 };
        return;
      }
      layers[i - 1].forEach((previous, k) => {
        const cost = best[i - 1][k].cost + candidate.cost + segmentCost(points[i].u - points[i - 1].u, candidate.frame - previous.frame);
        if (cost < best[i][j].cost) best[i][j] = { cost, from: k };
      });
    });
  }
  let pick = -1;
  let total = Infinity;
  if (!points.length) {
    total = segmentCost(U, endFrame - startFrame);
  } else {
    const last = points.length - 1;
    layers[last].forEach((candidate, j) => {
      const cost = best[last][j].cost + segmentCost(U - points[last].u, endFrame - candidate.frame);
      if (cost < total) { total = cost; pick = j; }
    });
  }
  if (!Number.isFinite(total)) {
    const detail = points.map((point) => `${point.id} u=${point.u.toFixed(2)} (${point.to})`).join(", ");
    throw new Error(`Chapter "${chapterId}" cannot be synced within ${MIN_RATE}-${MAX_RATE}x: ${U.toFixed(2)} s of footage into ${(T1 - T0).toFixed(2)} s. Anchors: ${detail}. Adjust the clip ranges in v7-edit.mjs.`);
  }
  const chosen = new Array(points.length);
  for (let i = points.length - 1; i >= 0; i -= 1) {
    chosen[i] = layers[i][pick];
    pick = best[i][pick].from;
  }
  return chosen;
}

// ---------------------------------------------------------------------------------------

export function buildV7Edit(manifest, beatmap, { motion = null, trace = null, appVersion = null } = {}) {
  const grid = createMusicGrid(beatmap);
  const visualAt = createVisualIndex(motion);
  const markers = new Map(manifest.markers.map((marker) => [marker.id, marker.seconds]));
  const marker = (id) => {
    if (!markers.has(id)) throw new Error(`Capture marker "${id}" is missing; re-run npm run capture.`);
    return markers.get(id);
  };
  const at = ([id, offset]) => marker(id) + offset;
  const visualOptions = (spec) => (spec.visual === true ? {} : spec.visual);

  // Resolves a clip bound or sync point's source reference to capture seconds. `offset` is
  // added after any visual refinement; `fallback` is used when a marker is missing.
  const resolveSource = (spec) => {
    if (Array.isArray(spec)) return at(spec);
    if (spec.marker && !markers.has(spec.marker) && spec.fallback) return resolveSource(spec.fallback);
    let seconds;
    if (spec.marker) seconds = marker(spec.marker);
    else if (spec.key) {
      const after = spec.after ? marker(spec.after) - 0.001 : -Infinity;
      const matches = (manifest.keys || []).filter((key) => key.label === spec.key && key.seconds >= after);
      const key = matches[spec.index || 0];
      if (!key) throw new Error(`Key "${spec.key}" after "${spec.after}" is missing from the capture.`);
      seconds = key.seconds;
    } else if (spec.click) {
      const after = spec.after ? marker(spec.after) - 0.001 : -Infinity;
      const matches = (manifest.clicks || []).filter((click) => click.label.includes(spec.click) && click.seconds >= after);
      const click = matches[spec.index || 0];
      if (!click) throw new Error(`Click "${spec.click}" is missing from the capture; re-run npm run capture.`);
      seconds = click.seconds;
    } else if (spec.ai) {
      const event = (manifest.aiEvents || []).find((item) => item.tool === spec.ai && item.phase === "complete");
      if (!event) throw new Error(`AI call "${spec.ai}" is missing from the capture.`);
      seconds = event.seconds;
    } else throw new Error(`Unknown source reference ${JSON.stringify(spec)}`);
    return (spec.visual ? visualAt(seconds, visualOptions(spec)) : seconds) + (spec.offset || 0);
  };

  // Chapter windows come from the beat map's sections.
  const sectionFor = (id) => {
    const name = id === "open" ? "title" : id === "end" ? "end-card" : id;
    const section = beatmap.sections.find((item) => item.name === name);
    if (!section) throw new Error(`Beat map has no "${name}" section.`);
    return section;
  };
  const plans = chapterPlans();
  const order = [...CHAPTERS.map((chapter) => chapter.id), "end"];
  const durationInFrames = Math.round(beatmap.durationSeconds * FPS);

  const clips = [];
  const chapters = [];
  const syncs = [];
  const freezes = [];
  const segments = [];
  for (const id of order) {
    const plan = plans[id];
    const section = sectionFor(id);
    const startFrame = Math.round(section.start * FPS);
    const endFrame = id === "end" ? durationInFrames : Math.round(section.end * FPS);
    // A free-time stop just before the next cut freezes the picture until the drop.
    const stop = grid.stops.find((time) => time > section.start + 0.5 && time < section.end - 0.02);
    const motionEndFrame = stop === undefined ? endFrame : Math.round(stop * FPS);
    if (stop !== undefined) freezes.push({ chapter: id, from: motionEndFrame, to: endFrame });

    // Concatenate the chapter's clips on a virtual source axis u.
    let U = 0;
    const members = plan.clips.map((clip) => {
      const a = resolveSource(clip.from);
      const b = resolveSource(clip.to);
      if (b - a < 0.3) throw new Error(`Clip ${clip.id} is too short (${(b - a).toFixed(2)} s).`);
      const member = { ...clip, a, b, u0: U };
      U += b - a;
      return member;
    });
    const points = [];
    members.slice(1).forEach((member) => points.push({ id: `cut:${member.id}`, u: member.u0, to: member.cutOn || "beat", cut: member.id }));
    for (const sync of plan.syncs) {
      const seconds = resolveSource(sync.src);
      const member = members.find((item) => seconds >= item.a - 1e-6 && seconds <= item.b + 1e-6);
      if (!member) throw new Error(`Sync ${sync.id} (source ${seconds.toFixed(3)} s) is outside every ${id} clip.`);
      points.push({ ...sync, u: member.u0 + (seconds - member.a), source: seconds });
    }
    points.sort((a, b) => a.u - b.u);
    for (let i = 1; i < points.length; i += 1) {
      if (points[i].u - points[i - 1].u < 0.05) throw new Error(`Sync points ${points[i - 1].id} and ${points[i].id} are too close in the footage.`);
    }
    const chosen = solveAnchors({ points, U, startFrame, endFrame: motionEndFrame, grid, chapterId: id });
    const anchors = [{ frame: startFrame, u: 0 }, ...points.map((point, index) => ({ frame: chosen[index].frame, u: point.u })), { frame: motionEndFrame, u: U }];
    for (let i = 1; i < anchors.length; i += 1) {
      const dFrames = anchors[i].frame - anchors[i - 1].frame;
      segments.push({ chapter: id, from: anchors[i - 1].frame, to: anchors[i].frame, rate: Number((((anchors[i].u - anchors[i - 1].u) * FPS) / dFrames).toFixed(3)) });
    }
    points.forEach((point, index) => {
      const candidate = chosen[index];
      syncs.push({
        chapter: id,
        id: point.id,
        label: point.label || point.keycap || point.id,
        to: point.to,
        frame: candidate.frame,
        target: Number(candidate.time.toFixed(6)),
        kinds: candidate.kinds,
        score: Number((candidate.score || 0).toFixed(3)),
        offsetMs: Number(((candidate.frame / FPS - candidate.time) * 1000).toFixed(1)),
        source: point.source === undefined ? null : Number(point.source.toFixed(3)),
        keycap: point.keycap || null,
        reveal: Boolean(point.reveal),
        cut: point.cut || null
      });
    });

    // u -> output frame, and output frame -> u, for this chapter.
    const uToFrame = (u) => {
      for (let i = 1; i < anchors.length; i += 1) {
        const a = anchors[i - 1];
        const b = anchors[i];
        if (u <= b.u + 1e-9) return a.frame + ((u - a.u) / (b.u - a.u)) * (b.frame - a.frame);
      }
      return anchors.at(-1).frame;
    };
    const memberFrames = members.map((member, index) => ({
      member,
      from: index === 0 ? startFrame : Math.round(uToFrame(member.u0)),
      to: index === members.length - 1 ? endFrame : Math.round(uToFrame(members[index + 1].u0))
    }));
    for (const { member, from, to } of memberFrames) {
      // The clip's time map: [local frame, source seconds] knots, linear between them and
      // held after the last one (the freeze through a stop).
      const knots = [];
      const localAnchors = anchors.filter((anchor) => anchor.u >= member.u0 - 1e-9 && anchor.u <= member.u0 + (member.b - member.a) + 1e-9);
      const sourceAtFrame = (frame) => {
        for (let i = 1; i < anchors.length; i += 1) {
          const a = anchors[i - 1];
          const b = anchors[i];
          if (frame <= b.frame) {
            const u = a.u + ((frame - a.frame) / Math.max(1, b.frame - a.frame)) * (b.u - a.u);
            return member.a + Math.min(member.b - member.a, Math.max(0, u - member.u0));
          }
        }
        return member.b;
      };
      knots.push([0, sourceAtFrame(from)]);
      for (const anchor of localAnchors) {
        const local = anchor.frame - from;
        if (local > 0 && local < to - from) knots.push([local, member.a + (anchor.u - member.u0)]);
      }
      knots.push([Math.min(to, motionEndFrame) - from, sourceAtFrame(Math.min(to, motionEndFrame))]);
      if (to > motionEndFrame) knots.push([to - from, knots.at(-1)[1]]);
      clips.push({
        id: member.id,
        chapter: id,
        from,
        duration: to - from,
        sourceSeconds: [Number(member.a.toFixed(3)), Number(member.b.toFixed(3))],
        map: knots.map(([frame, seconds]) => [frame, Number(seconds.toFixed(4))]),
        flash: member.flash !== false,
        cam: []
      });
    }
    chapters.push({ id, title: CHAPTERS.find((chapter) => chapter.id === id)?.title || "End card", startFrame, endFrame, motionEndFrame, stop: stop ?? null });
  }

  // Camera keyframes, written against the solved output times.
  const syncTime = new Map(syncs.map((sync) => [sync.id, sync.frame / FPS]));
  for (const chapter of chapters) {
    const chapterClips = clips.filter((clip) => clip.chapter === chapter.id);
    const ctx = {
      start: chapter.startFrame / FPS,
      end: chapter.endFrame / FPS,
      motionEnd: chapter.motionEndFrame / FPS,
      t: (id) => {
        if (!syncTime.has(id)) throw new Error(`Camera refers to unknown sync point "${id}".`);
        return syncTime.get(id);
      },
      clipStart: (id) => chapterClips.find((clip) => clip.id === id).from / FPS,
      clipEnd: (id) => { const clip = chapterClips.find((item) => item.id === id); return (clip.from + clip.duration) / FPS; },
      beatFrom: grid.beatFrom,
      nextBar: grid.nextBar,
      previousBar: grid.previousBar,
      snap: grid.snap
    };
    const cams = plans[chapter.id].cam(ctx);
    for (const clip of chapterClips) {
      const keys = cams[clip.id] || [[clip.from / FPS, 1, 960, 540]];
      clip.cam = keys
        .map(([time, s, x, y]) => ({ f: Math.max(0, Math.round(time * FPS) - clip.from), s, x, y }))
        .sort((a, b) => a.f - b.f);
    }
  }

  const clipById = new Map(clips.map((clip) => [clip.id, clip]));
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const syncById = new Map(syncs.map((sync) => [sync.id, sync]));
  // Beat frames at or after a frame, for timing overlay elements to the grid.
  const beatFramesAfter = (frame, count) => grid.beats.map((beat) => Math.round(beat * FPS)).filter((beatFrame) => beatFrame > frame).slice(0, count);

  // Captions: the v6 copy, slammed in on each chapter's downbeat (or the clip's bar cut).
  const captions = captionPlan(manifest.texts || {}, manifest.aiClient).map((caption) => {
    const first = clipById.get(caption.clip);
    if (!first) throw new Error(`Caption clip ${caption.clip} is missing from the v7 plan.`);
    const chapter = chapterById.get(first.chapter);
    const last = clipById.get(caption.until || caption.clip);
    const end = last && last.chapter === first.chapter ? last.from + last.duration : chapter.endFrame;
    const settle = caption.settleOn === "ops-complete" ? syncById.get("transfer-complete")?.frame : null;
    return {
      ...caption,
      from: first.from,
      duration: end - first.from,
      chipFrames: beatFramesAfter(first.from, caption.proof.length).map((frame) => frame - first.from),
      settleAt: settle ? settle - first.from : null
    };
  });

  const keys = syncs.filter((sync) => sync.keycap).map((sync) => ({ label: sync.keycap, from: sync.frame }));
  const beatFrames = Math.round(grid.beatLength(beatmap.sections[1].start) * FPS);

  // AI panel rows appear on their anchored beats; the "revealed" banner one beat after the reveal.
  const aiRows = (manifest.aiEvents || [])
    .filter((event) => event.phase === "complete")
    .map((event) => {
      const sync = syncById.get(event.tool === "show_in_explore_better" ? "ai-reveal" : `ai-row-${event.tool}`);
      return sync ? { tool: event.tool, detail: event.detail || "", at: sync.frame } : null;
    })
    .filter(Boolean);
  const aiStart = clipById.get("ai-ask");
  const aiEnd = clipById.get("ai-reveal");
  const aiChapter = chapterById.get("ai");
  const aiReveal = syncById.get("ai-reveal");
  const aiSourceSpan = aiEnd.sourceSeconds[1] - aiStart.sourceSeconds[0];
  const aiUsed = clips.filter((clip) => clip.chapter === "ai").reduce((sum, clip) => sum + clip.sourceSeconds[1] - clip.sourceSeconds[0], 0);
  const ai = {
    client: /codex/i.test(manifest.aiClient || "") ? "Codex CLI" : "MCP client",
    from: aiStart.from,
    duration: aiChapter.endFrame - aiStart.from,
    task: "Find the release checklist and reveal it in my active pane.",
    rows: aiRows,
    doneAt: beatFramesAfter(aiReveal.frame, 1)[0] ?? aiReveal.frame + beatFrames,
    trimmedSeconds: Math.round(Math.max(0, aiSourceSpan - aiUsed)),
    onBeat: true
  };

  // Transitions: a short luminance flash plus a scale punch on drops after silent stops,
  // a lime edge flash plus a smaller punch on stab/impact cuts, the v6 edge flash on
  // intra-chapter cuts.
  const flashes = [];
  for (const chapter of chapters) {
    if (chapter.startFrame === 0) continue;
    const moment = grid.momentAt(chapter.startFrame / FPS) || grid.nearestStrongHit(chapter.startFrame / FPS, 0.02, 0);
    const kinds = moment?.kinds || [];
    flashes.push({ frame: chapter.startFrame, kind: kinds.includes("drop") ? "drop" : "stab", chapter: chapter.id, hit: kinds.join("+") || "downbeat" });
  }
  for (const clip of clips) {
    const chapter = chapterById.get(clip.chapter);
    if (clip.from !== chapter.startFrame && clip.flash) flashes.push({ frame: clip.from, kind: "cut", chapter: clip.chapter, hit: "beat" });
  }
  flashes.sort((a, b) => a.frame - b.frame);

  // Restrained beat-reactive accents: a ~2% pulse on kick accents in the high-energy
  // sections, none in the breakdown, none during stops, none where a cut already punches.
  const pulses = [];
  const busy = new Set(flashes.map((flash) => flash.frame));
  for (const moment of grid.moments) {
    if (!moment.kinds.includes("kick-accent")) continue;
    const frame = Math.round(moment.time * FPS);
    const section = grid.sectionAt(moment.time);
    if ((section.energy ?? 0) < 0.75 || section.name === "title" || section.name === "end-card") continue;
    if ([...busy].some((flashFrame) => Math.abs(flashFrame - frame) <= 3)) continue;
    if (freezes.some((freeze) => frame >= freeze.from - 2 && frame <= freeze.to)) continue;
    pulses.push({ frame, amp: 0.02, kind: "kick-accent" });
  }
  for (const sync of syncs) {
    if (!sync.reveal) continue;
    const section = grid.sectionAt(sync.frame / FPS);
    if ((section.energy ?? 0) < 0.75) continue;
    const existing = pulses.find((pulse) => Math.abs(pulse.frame - sync.frame) <= 2);
    if (existing) { existing.amp = 0.028; existing.kind = "reveal"; } else pulses.push({ frame: sync.frame, amp: 0.028, kind: "reveal" });
  }
  pulses.sort((a, b) => a.frame - b.frame);

  const open = chapterById.get("open");
  const heroBeats = grid.beats.filter((beat) => beat < open.endFrame / FPS).map((beat) => Math.round(beat * FPS));
  const riser = grid.moments.find((moment) => moment.kinds.includes("riser-start") && moment.time < open.endFrame / FPS);
  const endChapter = chapterById.get("end");
  const endBeats = beatFramesAfter(endChapter.startFrame, 4).map((frame) => frame - endChapter.startFrame);

  return {
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    durationInFrames,
    sourceSize: manifest.resolution,
    appVersion,
    beatFrames,
    clips,
    chapters: chapters.filter((chapter) => chapter.id !== "end"),
    captions,
    keys,
    ai,
    flashes,
    pulses,
    freezes,
    hero: { eyebrowAt: riser ? Math.round(riser.time * FPS) : 6, headlineAt: heroBeats[0] ?? 18, taglineAt: heroBeats[2] ?? 46, outAt: open.endFrame },
    endFrom: endChapter.startFrame,
    endCard: { beats: endBeats },
    syncs,
    segments,
    music: { candidate: beatmap.candidate, name: beatmap.name, wav: beatmap.audio?.wav || null, sha256: beatmap.audio?.sha256 || null },
    trace: trace ? { client: trace.client } : null
  };
}
