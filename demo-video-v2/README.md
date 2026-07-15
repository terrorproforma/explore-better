# Explore Better hype demo v2

This cut matches the current website's ink, fluorescent lime, off-white, Bahnschrift/Aptos typography, compact mono proof labels, and published landing-page copy. It uses one continuous recording of the real Electron app instead of a sequence of static UI slides.

## Build

```powershell
cd path\to\explore-better\demo-video-v2
npm install
npm run capture
npm run render
npm run render:industrial
```

The capture script creates a disposable demo workspace, curated `Project files` / `Release ready` panes, and a read-only AI Bridge profile under a temporary local app-data directory. The walkthrough performs a real staged copy preview, including conflict detection and a safe rename, without applying the operation or modifying the user's live files and settings.

The final master is written to `output/explore-better-hype-demo-v2-1080p.mp4`. The output folder also contains a poster, contact sheet, source score, and JSON manifest.

## Industrial score variant

`npm run render:industrial` preserves the approved picture edit and creates `output/explore-better-hype-demo-v3-industrial-1080p.mp4` with a darker original score. The synthesis uses an original 116 BPM bass cell, machine-room drone, mechanical percussion, cue-specific impacts, a half-time transfer-preview section, and a separate AI Bridge response line. No samples or borrowed musical material are used.

The variant also exports the raw synthesized score, a mastered 24-bit WAV, waveform, spectrogram, and `manifest-v3-industrial.json` with cue times, loudness, and SHA-256 integrity data. The score generator lives in `src/audio/industrial-score.mjs` and requires only Node.js; it reuses the existing silent picture master.

## Tight website cut

`npm run render:tight` rebuilds the picture and score as a 45.7-second product-led cut. It removes 9.3 seconds of idle holds without accelerating the recorded interactions, moves the safety proof earlier, and realigns every musical marker to the revised edit.

The command writes the 1080p master to `output/explore-better-hype-demo-v4-tight-industrial-1080p.mp4`, exports review and audio artifacts, and produces the optimized `site/assets/explore-better-demo.mp4` plus its WebP poster for the landing-page player. `output/manifest-v4-tight.json` records the chapter timing, loudness, file sizes, and SHA-256 hashes.

## Value + Codex cut

`npm run capture` now records a wider native 1600×900 app session and a real Codex handoff through the disposable demo's scoped read-only MCP profile. Codex calls `get_context`, `search_files`, and `show_in_explore_better`; the resulting trace is saved alongside the footage and replayed transparently at edit speed.

`npm run render:value` creates the 64.5-second v5 master. Every feature starts with a full-workspace establishing frame before a restrained detail push, and each chapter leads with its outcome: faster discovery, visual disk clarity, visible transfer risk, a folder-ready terminal, live AI context, and per-client authority. The command also replaces the landing-page MP4 and poster with the optimized v5 assets and writes `output/manifest-v5-value-codex.json` with the source markers and Codex evidence.

## Editing direction

- One anchored product window supplies spatial continuity.
- Camera moves are motivated by the active control or drawer.
- Kinetic copy punctuates real interactions instead of replacing them.
- The site narrative runs from human/AI context, through command, disk map, safe transfer preview and terminal, into scoped MCP tools and proof.
- Off-thread source decoding keeps every UI frame deterministic in the final render.
- All score and UI footage are original to this project.
