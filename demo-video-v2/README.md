# Explore Better product demos

Every cut matches the website's ink, fluorescent lime and off-white palette, Bahnschrift/Aptos typography and mono proof labels. All product footage is one continuous recording of the real Electron app; nothing in the UI is mocked.

## Current website cut: v6

```powershell
cd path\to\explore-better
npm run build:renderer          # the capture launches the local app bundle
cd demo-video-v2
npm install
npm run capture                 # records the real app (about two minutes)
npm run render:v6               # master, silent cut, score, web assets, review files
```

v6 is a product-led cut of about 56 seconds at 1920×1080 and 30 fps. Each chapter opens on the user outcome, and the burned-in kinetic captions tell the whole story with the sound off, which matters because the site player autoplays muted. Keycaps show every shortcut on screen.

| Chapter | What the real app does |
| --- | --- |
| Overview | Establishing shot of the dual-pane workspace |
| Filtered Search | Command palette → Search → files larger than 5 MB. Results land in the pane (the size filter fix from 0.2.7) |
| Exact Disk Map | Size Analyzer scan and nested map with exact disk allocation |
| Preview + Copy | Ctrl+A, F5 → transfer preview with three real name conflicts → Apply → live progress in Operations → completed, undoable |
| Safe + Keyboard-First | Inline rename onto an existing name is refused, then Shift+F10 opens the context menu and arrow keys move a visible focus ring |
| Terminal Follows | Per-tab PowerShell that follows the pane into `04 Launch` |
| Live AI Context | A real MCP client (Codex CLI when installed) calls `get_context`, `search_files` and `show_in_explore_better`, and the pane reveals the file |
| Scoped AI Access | The read-only AI Bridge profile scoped to one folder, then settings search narrows to its audit trail of those calls |

### Capture safety

`capture-app-footage.mjs` builds a disposable workspace at `C:\Demo` (set `EB_DEMO_ROOT` to use another unused folder). The script refuses to touch an existing folder unless it carries the marker file it writes itself. The app runs with its own `USERPROFILE`, `LOCALAPPDATA`, `APPDATA` and Electron user data inside that folder, so your real files, settings and AI Bridge profiles are never read or changed. Nothing touches the registry. The folder is deleted when the capture ends. The short root also keeps every on-screen path free of user names.

The capture renders the UI at 1440×810 CSS pixels with a 2× device scale (a 2880×1620 source), so the edit can push in without upscaling. Screencast frames are re-timed to a constant 30 fps from their own timestamps. Markers, element rectangles, keypresses and on-screen text such as the copy duration go into `capture/capture-manifest.json`. `src/v6-edit.mjs` addresses every clip, camera move and caption relative to those markers, so a fresh capture re-times the edit automatically.

### AI handoff

If `codex` is on `PATH` (or `CODEX_CLI_PATH` is set), the capture runs `codex exec` against the demo's read-only MCP profile through the app's own sidecar, and the video names it "Codex CLI". Otherwise, or if Codex fails, a minimal scripted client makes the same three stdio JSON-RPC calls to the same sidecar, and the video says "MCP client". Set `EB_DEMO_MCP_CLIENT=scripted` to force the scripted client. The on-screen trace panel is built from the recorded calls (`capture/ai-handoff-trace.json`) and states how many seconds of model thinking were cut. The Scoped AI Access chapter then shows the app's own audit log of those calls.

### Outputs

- `output/explore-better-hype-demo-v6-1080p.mp4`: the master, with the original score.
- `output/explore-better-hype-demo-v6-silent.mp4`: the same picture with no audio.
- `output/explore-better-demo-v6.vtt`: WebVTT captions that mirror the burned-in text.
- `output/explore-better-v6-contact-sheet.jpg`, `output/explore-better-v6-poster.png`: review files.
- `output/manifest-v6.json`: chapters, captions, clip sources, AI evidence, loudness, sizes and SHA-256 hashes.
- `site/assets/explore-better-demo.mp4`: two-pass H.264 at 1600×900 with faststart and yuv420p, kept under 8 MB.
- `site/assets/explore-better-demo-poster.webp`: 1600×900, kept under 120 KB.
- `chapters-v6.json` (tracked): chapter titles and start times for the website's chapter list.

`npm run render:v6 -- --stills 60,600,1200` renders only those frames to `output/review-v6/` for quick layout checks.

The score comes from `src/audio/industrial-score.mjs` (see below). It is re-timed to the v6 chapter points at 120 BPM and mastered to about −15 LUFS. It is fully synthesized, with no samples or borrowed material.

Generated media (`capture/`, `output/`, `public/live.mp4`) is gitignored. Older cuts (v2–v5) were edited against earlier captures and are kept for reference. Their scripts expect the capture from their own era, which is in git history.

## Music candidates (v7)

```powershell
cd demo-video-v2
npm run render:music            # all three candidates, about 30 seconds
npm run render:music -- B       # one (or any subset) of A, B, C
```

This replaces only the soundtrack. It reads `chapters-v6.json` and the published picture `site/assets/explore-better-demo.mp4`, then writes three fully arranged and mastered scores. Each one is muxed onto that picture with `-c:v copy`, so the video stream stays bit-identical. Nothing in `site/assets` is changed. The owner picks a candidate before the site MP4 is replaced.

| | Style | Tempo (nominal / per chapter) | Key and harmony |
| --- | --- | --- | --- |
| A | Warm electronic: soft four-on-the-floor, detuned supersaw pads with filter movement, pluck arpeggio, round sub, gentle kick-keyed pumping, airy hats and shaker, sparse FM-bell counter-line in the two peak chapters | 114 BPM (111.8–116.1) | F major, vi–IV–I–V loop, breakdown on IV–I/3–ii, final vi–ii–IV–V → Fadd9 |
| B | Minimal piano + pulse: additive piano ostinato with velocity and humanised timing, soft sub pulse, rim, shaker, felt kick, string swells into each chapter | 99 BPM (96.8–100.8) | D major, I–V/3–vi / IV–I/3–V, final IV–ii–Vsus–V → Dadd9 |
| C | Upbeat synth-pop: punchy kick and clap, driving eighth-note bass, gated arpeggio, short hook at the title that returns over the final V bar | 123 BPM (120.9–125.8) | G major, IV–V into I at the first chapter, I–V/3–vi–IV, final vi–ii–IV–V → G |

**Timing.** Every chapter is a whole number of beats. Tempo is constant inside a chapter and nudged by at most about 2.5 % between chapters, so every chapter cut and the end card fall exactly on a bar line (0 ms offset, sample-quantised). When a chapter is not a multiple of four beats, the remainder becomes a 1–3 beat pickup bar at the end of that chapter. That bar carries the fill, the stop or the riser into the next downbeat. The music follows the exact picture-cut frames, which scene detection finds within 3 ms of the rounded JSON times. The title card has no hard cut, so the first chapter uses its JSON time. The end card cut (52.900 s) is detected the same way. The title card starts with a pad from 0 s and a one-bar pickup. The last chapter cadences onto the tonic at the end card, and everything decays naturally, with a 0.7 s raised-cosine safety fade that ends on the last frame.

**Synthesis and mix** (`src/audio/score-v7.mjs`, no dependencies). The module uses polyBLEP band-limited oscillators and an additive piano built from inharmonic partials, hammer strike-position comb, two-stage decay, detuned unison strings and a damper. Filters are TPT state-variable (enveloped and LFO-modulated) and RBJ biquads. Envelopes are ADSR. Effects are a cross-fed chorus, a tempo-synced ping-pong delay and an 8-line FDN reverb. Every stem is level-matched to a K-weighted target, EQ-carved (high-passed pads, bass low-passed, hats low-passed at 10–11 kHz) and ducked from the kick where it fits the style. The drum bus is compressed. Mastering applies a 30 Hz 4th-order high-pass, a gentle tilt EQ and glue compression. A BS.1770 loop then sets −16 LUFS integrated, and an offline true-peak limiter caps output at −1.8 dBTP, so the AAC stays at or below −1.5 dBTP. Masters are 48 kHz / 24-bit with TPDF dither.

**Outputs** in `output/music-v7/` (gitignored):

- `explore-better-music-<A|B|C>.wav`: the masters.
- `explore-better-demo-<A|B|C>.mp4`: preview cuts (AAC 192 kbps, 48 kHz stereo).
- `review-<X>.png`: log-frequency spectrogram over the waveform. Blue lines mark the cuts; grey lines mark 30 Hz and 10 kHz.
- `review-<X>-low.png`: 0–500 Hz, for the sub and rumble check.
- `manifest.json`: tempo map, key, progression per chapter, cue alignment table (chapter time vs nearest bar and beat in ms, plus what a constant tempo would have missed by), per-chapter loudness, and meters for WAV and MP4 (integrated loudness, LRA, true peak, DC offset, band RMS below 30 Hz and above 10 kHz, stereo phase). Everything is measured independently with ffmpeg.

## v2 (original hype cut)

`npm run render` renders the first continuous-recording cut to `output/explore-better-hype-demo-v2-1080p.mp4`, with a poster, contact sheet, source score and JSON manifest.

## Industrial score variant

`npm run render:industrial` preserves the approved picture edit and creates `output/explore-better-hype-demo-v3-industrial-1080p.mp4` with a darker original score. The synthesis uses an original 116 BPM bass cell, machine-room drone, mechanical percussion, cue-specific impacts, a half-time transfer-preview section, and a separate AI Bridge response line. No samples or borrowed musical material are used.

The variant also exports the raw synthesized score, a mastered 24-bit WAV, waveform, spectrogram, and `manifest-v3-industrial.json` with cue times, loudness, and SHA-256 integrity data. The score generator lives in `src/audio/industrial-score.mjs` and requires only Node.js; it reuses the existing silent picture master.

## Tight website cut

`npm run render:tight` rebuilds the picture and score as a 45.7-second product-led cut. It removes 9.3 seconds of idle holds without accelerating the recorded interactions, moves the safety proof earlier, and realigns every musical marker to the revised edit.

The command writes the 1080p master to `output/explore-better-hype-demo-v4-tight-industrial-1080p.mp4`, exports review and audio artifacts, and produces the optimized `site/assets/explore-better-demo.mp4` plus its WebP poster for the landing-page player. `output/manifest-v4-tight.json` records the chapter timing, loudness, file sizes, and SHA-256 hashes.

## Value + Codex cut

The v5 capture (in git history) recorded a native 1600×900 app session and a real Codex handoff through the disposable demo's scoped read-only MCP profile. Codex called `get_context`, `search_files`, and `show_in_explore_better`, and the resulting trace was replayed transparently at edit speed.

`npm run render:value` creates the 64.5-second v5 master. Every feature starts with a full-workspace establishing frame before a restrained detail push, and each chapter leads with its outcome: faster discovery, visual disk clarity, visible transfer risk, a folder-ready terminal, live AI context, and per-client authority. The command also replaces the landing-page MP4 and poster with the optimized v5 assets and writes `output/manifest-v5-value-codex.json` with the source markers and Codex evidence.

## Editing direction

- One anchored product window supplies spatial continuity.
- Camera moves are motivated by the active control or drawer.
- Kinetic copy punctuates real interactions instead of replacing them.
- The site narrative runs from human/AI context, through command, disk map, safe transfer preview and terminal, into scoped MCP tools and proof.
- Off-thread source decoding keeps every UI frame deterministic in the final render.
- All score and UI footage are original to this project.
