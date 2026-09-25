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

## Feature clips (website feature grid)

```powershell
cd path\to\explore-better
npm run build:renderer
cd demo-video-v2
npm install
npm run capture:features        # 13 real app recordings, about eight minutes
npm run render:features         # web clips, posters, features.json, contact sheets
```

One short, silent, looping clip per feature, each its own real recording of the Electron app. `site/assets/features/features.json` is the contract the website builds against: `{ version, clips: [{ id, title, summary, src, poster, width, height, durationSeconds, alt }] }`, in this order:

| Clip | What the real app does |
| --- | --- |
| `dual-pane` | New tab, drill into two folders, tiles view, breadcrumb back, switch tabs, focus the other pane |
| `terminal` | Ctrl+\` opens the tab's PowerShell; opening a folder sends `Set-Location`; `Get-ChildItem \| Select -First 5` |
| `disk-map` | Scan, hover blocks, focus `02 Product` in the treemap, Top Files table |
| `transfer` | Ctrl+A, F5: preview with rename, overwrite and skip conflicts; Apply; live progress; Undo restores all 360 photos |
| `large-folder` | A 100,000-file folder (generated for the clip, then deleted) opens, scrolls, End jumps to the last entry |
| `search` | Files larger than 5 MB modified in the last 7 days; results land in the pane |
| `compare-sync` | Compare two Website folders, then Plan L->R (never applied) |
| `previews` | Preview panel: Markdown, PNG, PDF, then a STEP assembly orbited in 3D |
| `command-palette` | Ctrl+P fuzzy search runs "Horizontal split panes", then "Vertical split panes" |
| `safe-rename` | F2 onto `README.md` is refused; a real rename is undone from Operations |
| `keyboard` | Arrow keys with a visible focus ring, Shift+F10 menu, arrows to Create Checksums, Enter, Esc |
| `ai-handoff` | A real Codex CLI run (`codex exec`) through the read-only MCP profile: `get_context`, `search_files`, `show_in_explore_better` |
| `ai-profile` | AI Bridge preferences: authorized folder, tool permissions, then the audit log of those calls |

Spec: 1280×800, 30 fps, H.264 High, yuv420p, `+faststart`, no audio track, 6–12 s, a 12-frame dissolve into the frames just before the first one so the clip loops, and each file at the lowest CRF that fits 1.5 MB (hard cap 2.5 MB). Posters are WebP under 60 KB, taken from a representative frame. `render-features.mjs` checks all of this with ffprobe (including that the `moov` atom precedes `mdat`) and fails the clip otherwise.

The capture reuses the v6 safety model: a disposable `C:\Demo` (or `EB_DEMO_ROOT`) with its own profile, app data and Electron user data, refused if the folder exists without the marker file, deleted afterwards; nothing touches the registry and Explorer integration is never opened. A watchdog also discards any clip in which a pane leaves the demo root or visible text contains the account name or the repository path (the unpackaged build's AI client snippet does, so the `ai-profile` clip uses settings search to keep it off screen). The UI renders at 1440×900 CSS pixels at the display's own scale factor (the WebGL terminal only paints correctly when the emulated and real scale factors match), so on a 150% display the source is 2160×1350 and the edit can push in about 1.6× without upscaling.

The AI clip is a real `codex exec` run when Codex is installed (otherwise the scripted stdio client, labelled "MCP client"). Model thinking time between the calls is cut, and a small mono label on screen states how many seconds were trimmed.

`src/features-edit.mjs` holds each clip's segments, camera moves, poster frame, title, summary and alt text, all relative to the capture's markers. `src/Features.jsx` is the Remotion composition (camera, keycaps, AI trace panel, loop dissolve). Useful flags: `npm run capture:features -- --only terminal,search` re-records some clips into the existing manifest, `npm run render:features -- --only terminal` re-renders some, and `npm run render:features -- --stills terminal:0,120` renders review stills to `output/features/`. Masters, props and contact sheets (`output/features/<id>-contact-sheet.jpg`) stay in the gitignored `output/`; raw recordings stay in `capture/features/`.

## Music candidates (v7)

```powershell
cd demo-video-v2
npm run render:music            # current candidates D2 and D3, about 40 seconds
npm run render:music -- D E     # any subset of A B C D E D2 D3; earlier rounds kept for reference
```

This replaces only the soundtrack. It reads `chapters-v6.json` and the published picture `site/assets/explore-better-demo.mp4`, then writes fully arranged and mastered scores. Each one is muxed onto that picture with `-c:v copy`, so the video stream stays bit-identical. Nothing in `site/assets` is changed. The owner picks a candidate before the site MP4 is replaced and the picture is re-cut to its beat map.

**Current candidates: D2 and D3 (overhauled club techno).** The owner preferred D, so D2 rebuilds it with real production techniques. D3 adds E's cinematic drama to D2's club groove. Both keep D's form and tempo map (128 BPM, free-time stops before the disk and transfer cuts, every cut on a downbeat) and master to −14 LUFS. The master uses a peak-to-loudness ratio (PLR) of about 8.5 dB, a density typical of techno, which puts peaks near −5 dBTP. They are mono below 120 Hz.

What changed compared with D:

- **Kick.** Rendered once, so every hit is sample-identical. It has a noise click plus a 1.9 kHz blip transient. A single oscillator falls from 180 Hz onto the F1 root, carrying both a saturated body (asymmetric shaper) and a clean sub tail on the same phase, so the layers cannot cancel. A soft clip glues it. The kick is the loudest low-end element: 8 dB above the bass in 40–120 Hz.
- **Bass.** Six detuned band-limited saws with random phase and slow drift, through a 24 dB/oct resonant low-pass. The filter has a velocity-scaled per-note envelope, a per-chapter automation curve and a slow LFO. Multiband drive splits it into a clean mono sine sub below 100 Hz, heavily driven mids (100 Hz–2 kHz, with a dip at 3 kHz) and gently driven highs. The pattern changes per bar: rolling 16ths with accents, octave jumps, key-aware flat-2 flicks and slides, sparse "call" bars and busier "response" bars. It ducks to −35 dB in the 70 ms after each kick (2 ms attack, 150 ms release).
- **Space.** FFT convolution reverb with generated impulse responses: pre-delay, early reflections, and decorrelated noise that decays exponentially and gets darker over time. A 0.55 s dark room serves the drums; a 2.4 s hall (3.0 s in D3) serves claps, stabs and the lead. The riff has a tempo-synced ping-pong delay.
- **Arrangement.** Something changes every one or two bars:
  - The hats evolve from offbeat 8ths to shuffled 16ths, then open hats, then ride in the peaks. Percussion, rim and metal layers enter and leave.
  - Every cut gets a fill: a snare roll (accelerating to 32nds), a tom fill, or a stop with a reversed-reverb swell. Noise and pitch risers run into the cuts, with sub drops, crashes and downlifters landing on them.
  - The safety chapter is a breakdown followed by an 8-beat build (8ths, then 16ths, then 32nds, with the kick dropping for the last two beats). It leads into the biggest drop at the terminal cut.
  - The riff develops over six different bars and trades bars with the bass.
- **Feel.** Hats and percussion get ±3–4 ms of jitter and velocity variation. The bass, lead and brass drift slowly in pitch. The synth bus runs through tape wow, flutter and saturation. A −58 dB noise floor adds glue.
- **Mix and master.** Everything except the kick and bass is high-passed at 120–150 Hz, pads are cut at 400 Hz, and distorted parts are cut at 3 kHz. The drums get parallel compression. The master chain is tape saturation, mono below 120 Hz, glue compression, a soft clipper, then a true-peak limiter.
- **D3 only.** Cold, saturated, dissonant brass stabs in F phrygian (b9, #11, a tritone stack, F minor against G-flat minor), with pitch dives into the find, transfer, terminal and scope cuts. Huge hall claps with a metallic layer. Sustained brass chords that open on builds. A parallel-distortion synth bus. One eerie held line runs from the breakdown through the biggest drop.

**Second round: D and E (superseded).** Original dark techno whose genre and production style follow Gesaffelstein-type dark techno / EBM. No riff, chord sequence, rhythm or sound is taken from any existing track.

| | Style | Tempo | Key and harmony |
| --- | --- | --- | --- |
| D | Club: relentless 4/4, saturated kick with a reverb rumble, rolling 16th off-beat distorted bass (octave and flat-2 flicks, bit-crush in places), gritty hats, metal hits, a sparse gliding square riff on the two AI chapters, stabs with gated reverb, impacts on the cuts | 128 BPM, with free-time stops before the disk and transfer cuts; 125.8–130.9 elsewhere | F minor with phrygian Gb; i–bVI–bVII, bII tension, breakdown bVI–iv–V, final V → i |
| E | Cinematic march (the *Pursuit*-style lane): massive dry distorted kick, huge cold claps with a metallic layer in a dark hall, saturated detuned brass stabs with dissonant voicings (b9, #11, tritone, two minor triads a half step apart) and pitch dives, sustained brass chords with builds that open the filter, an eerie held high line with vibrato and slow drift, sparse ticks, stops before key cuts, and a drone-and-stabs breakdown mid-video | 122 BPM (120.9–122.7), with free-time stops before the transfer and scope cuts | E phrygian; i–bVI–bII, breakdown bVI–iv–V, final V → i |

The first round (A warm electronic, B minimal piano, C synth-pop; −16 LUFS masters) was rejected and is kept in the module for reference.

**Timing.** Every chapter is a whole number of beats, so every chapter cut and the end card land exactly on a bar line (0 ms offset, sample-quantised). A chapter either nudges its tempo slightly, or keeps the preset tempo and ends in a short free-time stop (0.2–0.45 s of silence plus tails and a reversed-reverb swell) that absorbs the remainder. With the stop, the next downbeat hits on the cut as a drop. When a chapter is not a multiple of four beats, the remainder becomes a 1–3 beat pickup bar carrying the fill, stop or riser. The music follows the exact picture-cut frames, which scene detection finds within 3 ms of the rounded JSON times. The title card has no hard cut, so the first chapter uses its JSON time. The end card cut (52.900 s) is detected the same way. The title plays a drone, a riser and a reversed swell, and the groove slams in at 2.5 s. The last impact lands on the end card, followed by a dark tail that decays to silence on the last frame.

**Beat maps for the picture re-edit.** Each render writes `output/music-v7/beatmap-<X>.json`. The current candidates are also copied to the tracked `music/beatmap-<X>.json` (D2 and D3 now; D and E from the previous round remain). All times are seconds, rounded to whole samples at 48 kHz:

- `tempoMap: [{ time, bpm }]`. An entry with `bpm: null` is a free-time stop or the title pre-roll.
- `beats`, and `bars` (downbeats).
- `sections: [{ name, start, end, energy }]`.
- `hits: [{ time, kind, strength }]`. Kinds are `impact`, `drop` (the downbeat after a stop), `stop`, `stab`, `clap`, `kick-accent`, `riser-start`, `riser-end`, `lead-in` and `lead-out`. Strength runs 0–1.

Chapter cuts stay on downbeats, so a re-edit keeps the cut points and moves intra-chapter events (caption slams, keycaps, zoom pushes, reveals) onto beats and strong hits.

**Synthesis and mix** (`src/audio/score-v7.mjs`, no dependencies). Everything is synthesized:
- **Oscillators:** polyBLEP band-limited, plus an additive piano (A–C).
- **Filters and envelopes:** TPT state-variable (enveloped and LFO-modulated) and RBJ biquad filters, with ADSR envelopes.
- **Effects:** chorus, a tempo-synced ping-pong delay, an 8-line FDN reverb, a short room reverb and a gated reverb.
- **Kick:** a two-stage pitch drop with an asymmetric waveshaper, choked by the next kick.
- **Bass:** pre- and post-drive around a resonant filter, with optional bit and sample-rate crush.
- **Percussion:** metal hits from inharmonic ring-modulated partials; hats from saturated noise and square "metal".
- **Transition effects:** reversed-reverb swells rendered through the reverb, noise risers and downlifters.

Every stem is level-matched to a K-weighted target, EQ-carved and ducked from the kick. The drum bus is compressed. E's brass runs on a synth bus with parallel distortion.

The D/E master chain:
1. 30 Hz high-pass and tilt EQ.
2. Tape-style saturation.
3. Mono below 120 Hz.
4. Glue compression.
5. A BS.1770 loop to −14 LUFS, with an offline true-peak limiter at −1.6 dBTP so the AAC stays at or below −1.0 dBTP.

A–C were mastered to −16 LUFS and −1.8 dBTP. Masters are 48 kHz / 24-bit with TPDF dither.

**Outputs** in `output/music-v7/` (gitignored):

- `explore-better-music-<X>.wav`: the masters.
- `explore-better-demo-<X>.mp4`: preview cuts (AAC 192 kbps, 48 kHz stereo).
- `beatmap-<X>.json`: see above.
- `review-<X>.png`: log-frequency spectrogram over the waveform. Blue lines mark the cuts; grey lines mark 30 Hz and 10 kHz.
- `review-<X>-low.png`: 0–500 Hz, for the sub and rumble check.
- `manifest.json`: status, tempo map (including stops), key, progression per chapter, cue alignment table (chapter time vs nearest bar and beat in ms, plus what a constant tempo would have missed by), per-chapter loudness, and meters for WAV and MP4 (integrated loudness, LRA, true peak, DC offset, band RMS below 30 Hz and above 10 kHz, stereo phase). Everything is measured independently with ffmpeg.

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
