# Explore Better

A local dual-pane file manager prototype for Windows power users. It is not a complete shell replacement yet; it now has the first working layers for browsing, tabs, preview, persistent layout, operation history, undoable file operations, Explorer integration files, and trusted scripting.

See [USER_MANUAL.md](USER_MANUAL.md) for the daily-use manual, keyboard shortcuts, resizing, file operations, scripting, and Explorer integration guidance.

## Run

```powershell
npm start
```

Open http://127.0.0.1:4627.

For the native desktop lister:

```powershell
npm run desktop
```

For a local unpacked Windows desktop build:

```powershell
npm run build:icon
npm run package:dir
```

For a portable unsigned Windows executable:

```powershell
npm run package:win
```

For an unsigned NSIS installer build:

```powershell
npm run build:icon
npm run package:installer
```

For a release-readiness check of the package config, generated Explorer integration kit, shell backup path, and Electron bridge:

```powershell
npm run verify:release-readiness
```

For a release-integrity manifest with SHA-256 hashes and freshness checks for the setup installer, blockmap, unpacked desktop executable, packaged app archive, and source inputs:

```powershell
npm run verify:release-integrity
```

For a consolidated release-bundle manifest that cross-checks the installer, blockmap, update feed, desktop updater smoke, signing rehearsal, shell install/revert proof, and readiness report:

```powershell
npm run verify:release-bundle
```

For production Authenticode signing proof, set `EXPLORE_BETTER_SIGNING_THUMBPRINT` or `EXPLORE_BETTER_SIGNING_SUBJECT` to the expected certificate identity, then run:

```powershell
npm run verify:production-signing
```

For a single production-readiness checklist that separates local release proof from external publish blockers:

```powershell
npm run verify:production-readiness
```

For a production-hosted update feed probe, set `EXPLORE_BETTER_UPDATE_URL` or `EB_UPDATE_URL` to the feed base URL or `latest.yml` URL, then run:

```powershell
npm run verify:hosted-update-feed
```

For one consolidated external certification pass across the current release bundle, attached device, production signing, and hosted update feed:

```powershell
npm run verify:external-proof
npm run verify:external-proof -- --strict
```

For one native-shell coverage checklist across This PC, Network, Recycle Bin, libraries, devices, ZIPs, shell verbs, shortcuts, links, real paths, and UNC loopback:

```powershell
npm run verify:native-shell-readiness
```

For an isolated shell-replacement rehearsal that installs and removes the app copy, shortcuts, and optional Win+E helper under temporary profile paths:

```powershell
npm run verify:shell-rehearsal
```

## Current Capabilities

- Dual panes with independent tabs, tab-close/reopen/cycle shortcuts, locked tabs, folder-row new-tab opens, browsable back/current/forward history, editable path bars with alias/root/recent/filesystem suggestions, clickable breadcrumbs, text/kind/label filtering, configurable details columns, file attribute metadata, recursive folder-size scanning, per-tab view modes, keyboard navigation, find-as-you-type name jumps, range selection, active-pane selection/contents summaries, a persistent Navigator rail, and persisted resizing for Navigator, pane splitters, Preview, and the command dock.
- Large folder views progressively render rows and tiles in frame-sized chunks so the lister paints quickly while preserving full-folder sorting, filtering, selection, and operations.
- Hidden/system item visibility can be toggled from the dock or command palette, with Windows attributes shown in real folder panes and editable for selected items.
- Optional Linked Panes mode that follows matching folder-tree navigation across the opposite pane.
- Auto Refresh for visible filesystem panes, with a dock toggle and lightweight folder-change signatures for external file changes.
- Named layouts that save and restore the full dual-pane workspace, including pane layout mode, tabs, active paths, history, filters, sorting, and view modes, and can be marked as the normal startup lister.
- Folder Tab Groups that save and restore the active pane's tab set without disturbing the other pane.
- File Collections that persist named virtual groups of files/folders from anywhere and open them as pane views.
- File Basket scratchpad for quickly gathering paths from many folders, then opening, copying, moving, or archiving them as one batch.
- Pane Snapshots that freeze the active pane's current listing, selection, and view settings as restorable virtual pane views.
- Path Labels with color badges, visible note/comment columns, pane filters, and metadata that follows app-managed copy/move/rename operations.
- Folder Formats that auto-apply saved view mode, sort, kind/label filters, and Details columns to exact folders or whole subtrees.
- Display Presets for reusable pane recipes that can be applied to any folder without tying them to a path rule.
- Filter Presets for reusable text, kind, and label pane filters that can be applied to any active pane.
- Selection Sets for saving the active pane's exact selected paths, then restoring them later by replacing, adding, removing, or keeping matches.
- File clipboard with Cut, Copy, Windows Explorer file-drop interop, conflict-aware Paste policies, visible cut-state feedback, standard keyboard shortcuts, and operation-history undo.
- Copy Names for sending selected full paths, filenames, parent folders, JSON, or CSV text to the Windows clipboard.
- Checksum manifests for selected files with SHA-256/SHA-1/MD5 hashing, size caps, skipped-folder reporting, clipboard copy, manifest/CSV/JSON downloads, and manifest verification.
- In-app right-click context menus for file rows and pane backgrounds, covering open, other-pane actions, clipboard, transfer, labels, collections, properties, refresh, and folder tools.
- Drag-and-drop file transfers between panes, from Windows Explorer/Desktop into panes, and from Explore Better back out to Windows Explorer/Desktop, with operation-history undo for app-managed drops.
- Lister layout controls for vertical split, horizontal split, and single active-pane focus.
- Advanced Select for replacing, adding, removing, or keeping visible matches by wildcard mask, item scope, size, modified/created age, and Windows attributes, with reusable select presets.
- Navigator rail with managed favorites, common shortcuts, a Windows Shell section for This PC, Libraries, Network, Recycle Bin, media folders, App Trash, and discovered `.library-ms` libraries, plus an in-app Shell Browser for enumerating virtual Windows namespace children such as drives, libraries, network providers, phones, and devices. Drive rows include free-space meters, the Folder Tree expands live folders, recent folders are saved, and real folders can open in either pane.
- Folder Aliases for saved path-bar shortcuts such as `proj:` and `proj:\src`, with Navigator rows and other-pane open actions.
- Copy and move selected items from one pane to the other, or use `Send To` to target the other pane, favorites, aliases, recents, common roots, drives, or a typed destination. Multi-item, folder, and conflict cases preflight through the Transfer dialog before touching disk.
- Conflict-aware Transfer dialog with global and per-item rename, overwrite, and skip policies, action counts, risky overwrite markers, a verified preview route that does not mutate files, and preview-digest guarded Apply calls that reject stale plans if the destination changes before disk mutation starts.
- ZIP archive browsing as read-only virtual folders from normal pane double-clicks, plus ZIP archive creation from selected files/folders and ZIP extraction into a target folder with undo through operation history.
- Inline rename, bulk rename with reusable rule presets, create folder, create text files from templates, create Windows `.lnk` shortcuts, create NTFS hard links, junctions, and symbolic links, set or clear Windows attributes, edit file timestamps, reveal in Explorer, move selected items to app trash, send selected items to the Windows Recycle Bin, and permanently delete selected items after typed confirmation.
- Open With handoff for launching the current selection through the default app, terminal, Explorer reveal, native Windows shell verbs, or a custom executable with path placeholders, reusable launch presets, and extension-matched quick launchers.
- Trash Browser for inspecting locally trashed App Trash items and Windows Recycle Bin items; App Trash entries can restore into the active pane or be permanently deleted, while Windows Recycle entries can restore through the native shell namespace with an auditable Ops row.
- Persistent layout, favorites, and settings in `%LOCALAPPDATA%\ExploreBetter\state.json`.
- Searchable command palette for built-in actions, saved trusted tools, and saved trusted scripts, with grouped results, hotkey badges, and keyboard selection.
- Saved trusted tools/commands with toolbar buttons.
- Configurable app hotkeys that bind keyboard shortcuts to built-in commands, saved tools, or saved scripts.
- Customizable command dock with saved visibility profiles so all commands remain searchable while the visible toolbar can stay focused.
- Preferences dialog for density, startup behavior, preview pane, app-trash confirmations, hidden/system visibility, auto refresh, linked navigation, paste conflict policy, and shell-open defaults.
- Full configuration backup packages for exporting and restoring layouts, aliases, basket contents, labels, folder formats, display presets, filter presets, selection sets, sync profiles, Open With presets, search presets, select presets, bulk rename presets, tools, scripts, hotkeys, and settings.
- Command execution through PowerShell or Command Prompt with captured stdout/stderr in operation history.
- Live operation queue monitor with queued/running/paused/completed/failed/canceled states, item-level and byte-level progress for copy/move/delete/transfer/sync/trash/recycle, elapsed timing, transfer rates, ETA, operation counts, pause/resume/cancel for transfer work, retry controls for recoverable failed or canceled file operations, recovery details with selected-item retry for failed copy/move/delete/transfer/sync/trash/recycle operations, launchable elevated helper packages for failed copy/move/permanent-delete remaining work, restart recovery for interrupted queued/running/paused operations, overwrite-backup recovery for selected transfer/sync replacements, and undo support for copy, move, transfer, rename, bulk rename, create-folder, shortcut creation, filesystem link creation, attribute changes, timestamp changes, text edits, and app-trash actions.
- Preview folders, text files, images, PDFs, audio, and video in the built-in inspector, with a larger in-app Viewer for previewable files, neighboring-file filmstrip navigation, and Home/End jumps.
- Quick Edit for small text files with an undoable save operation in the built-in operation history.
- Details, compact, and tile browsing modes, including image thumbnails in tile view, optional image dimension metadata, optional Link/Target columns for hard links, symbolic links, and junctions, plus label notes/comments as a Details column.
- Folder Size scanning in panes, a WizTree-style Size Analyzer with logical and allocated size totals, top folders/files/extensions, type categories, cold in-flight scan coalescing, a visible Cancel flow for abandoned scans, short warm-cache repeat scans, operation/script invalidation, and an interactive treemap chart that can select the real file behind a block, a Properties and size audit dialog with recursive folder totals, timestamps, optional file hashes, and bounded Path Health diagnostics for local, UNC, and mapped-drive targets, plus native Windows Properties sheets through `Alt+Enter`.
- Bounded Flat View that recursively flattens files, folders, or both into the active pane with parent paths preserved.
- Duplicate Finder with same-size candidate grouping, optional SHA-256 confirmation, bounded scan/hash limits, and virtual result panes.
- Advanced bounded recursive search:
  - filename search,
  - text-file content search,
  - kind filters,
  - size, modified/created age, and Windows attribute criteria,
  - scan/result limits,
  - optional Warm Cache mode for querying saved background-index roots from the normal Search dialog,
  - virtual result panes with preview/reveal support.
- Speed Index panel that first shows live active-pane timing/source/item telemetry, then builds a persistent per-folder filename/metadata index under `%LOCALAPPDATA%\ExploreBetter\Index`, optionally warming image dimensions and link targets, and searches that warm cache without a fresh filesystem scan.
- Background Index roots for bounded recursive filename, metadata, label, note, and optional text-content indexing. The background index writes aggregate warm-cache search files per root, supports start/stop/remove controls, and searches saved roots without a live filesystem crawl.
- Background index freshness checks and bounded root watchers that mark a warm cache stale when sampled folder/file stamps or watched folders change, auto-start a bounded rebuild for enabled roots, survive backend restarts, then clear after recovery.
- Folder compare and sync between left/right panes:
  - left-only/right-only/newer/different/type-mismatch classification,
  - recursive or top-level compare,
  - reusable Sync Profiles for saved folder pairs and compare/sync options,
  - selected-row sync left-to-right or right-to-left,
  - optional mirror-extra cleanup that moves selected destination-only items into App Trash,
  - operation-history logging and undo metadata.
- Explorer Replacement Center with generated-file checks, shell preflight review, registry handler status, shell backup/restore, native/package/install readiness, app-window browser support, reversible Start Menu/Desktop shortcuts, optional Win+E helper status, one-click current-user integration cleanup, readiness scoring, shell-open behavior with file-target selection, and launch-test plus current-user app install actions. Normal browsing stays under the current user; Windows legacy known-folder junctions such as `Documents\My Videos` redirect to their real known folders, while genuinely protected folders show an access note instead of requiring the whole app to run as administrator.
- Optional Electron native-window wrapper with single-instance shell-open routing, embedded server startup, packaged-app detection, a disabled-by-default update-check bridge, and an Integration Center launch mode for desktop-lister behavior.
- Release readiness, integrity, bundle, and production-readiness smoke tests for package metadata, branded Windows icon configuration, installer-target configuration, generated integration files, native shell-target readiness, restore backup generation, updater runtime bridge, static update-feed artifacts, Electron desktop bridge, setup/blockmap/app-archive SHA-256 manifests, source freshness, code-signing rehearsal, current-user shell proof, a consolidated publishable release manifest, and final checklists that separate local release/native-shell proof from signing/feed/hardware blockers.
- Isolated shell-replacement rehearsal for installing/removing the current-user app copy, Start Menu/Desktop shortcuts, optional Win+E startup helper, and generated shell-handler files without importing HKCU registry files into the real user shell; the current-user shell verifier imports real HKCU handlers, proves the installed desktop handler opens a target folder, then restores the original shell keys.
- Generated Windows integration files in `%LOCALAPPDATA%\ExploreBetter\Integration`:
  - `explore-better-open.ps1`
  - `explore-better-server.ps1`
  - `install-shortcuts.ps1`
  - `remove-shortcuts.ps1`
  - `explore-better-win-e.ps1`
  - `install-win-e-startup.ps1`
  - `remove-win-e-startup.ps1`
  - `install-context-menu.reg`
  - `remove-context-menu.reg`
  - `install-folder-default.reg`
  - `remove-folder-default.reg`
  - `restore-previous-shell.reg`
- Trusted JavaScript scripting with helper APIs:
  - `api.checkpoint()`
  - `api.progress(progress, completed, total)`
  - `api.sleep(ms)`
  - `api.list(path)`
  - `api.mkdir(parent, name)`
  - `api.rename(path, name)`
  - `api.copy(paths, targetDir)`
  - `api.move(paths, targetDir)`
  - `api.trash(paths)`
  - `api.writeText(path, content)`
- Saved script library with trusted snippet editing, progress reporting, cooperative pause/cancel checkpoints, run output, operation-history audit entries, one-click toolbar script buttons, and script package import/export.
- Tool package import/export for moving trusted toolbar commands between Explore Better installs as JSON.

## Performance Notes

Explore Better treats browsing speed as a core feature. The server enumerates folder metadata with bounded concurrent stat work instead of serially waiting on each file, while preserving stable entry order and hidden/system filtering. Expensive metadata is demand-driven: normal listings skip image-header parsing, link-target/hardlink enrichment, Windows `attrib.exe` attribute sweeps, and full-folder signature hashing, then request that work only when the active columns, sort, Folder Format, Display Preset, hidden/system filtering, or fallback refresh mode needs `Dim`, `Link`, `Target`, `Attr`, or signature metadata. Pane navigation uses per-pane abort controllers and load sequence checks, so rapid folder changes cancel stale `/api/list` requests and late responses cannot overwrite the newest pane state. The server also observes disconnects for listing, folder-signature, and tree requests so abandoned navigation stops starting new filesystem metadata work instead of competing with the current folder. Live folder-list responses include low-overhead phase timings, and the status bar plus Speed panel show total load time, source, read/stat/filter/label timings, worker count, and visible/total item counts so performance regressions are visible while browsing. Recent folder listings are kept in a short-lived, bounded in-memory cache keyed by path, hidden/system visibility, and requested metadata mode, giving back/forward, tab switches, and quick revisits an instant paint path while explicit refreshes and operation-driven refreshes force a fresh listing. Folder hover and keyboard focus also run a bounded, abortable predictive prefetch for directories, warming that exact listing cache with the active pane's metadata mode before navigation; real navigation cancels any matching unfinished prefetch so background work never competes with the foreground load. Successful filesystem-changing APIs clear the listing cache and abort stale prefetches, while harmless state, label, clipboard, preview, and search requests leave it intact. The Shell Browser uses short namespace timeouts, a stricter Network namespace guard, and a small warm cache so slow shell providers cannot stall repeated browsing. The Speed Index panel adds a persistent per-folder metadata cache under `%LOCALAPPDATA%\ExploreBetter\Index`: it builds from the same fast listing path, stores compact searchable rows, optionally warms image dimensions and link targets, and serves filename/metadata lookups without a fresh filesystem scan. Image dimension parsing also has a persistent per-folder cache under `%LOCALAPPDATA%\ExploreBetter\MetadataCache\Dimensions`, keyed by path, size, and modified time, so media folders pay image-header reads once and report cache hits on warm scans. Raw preview and tile-thumbnail streams use ETag/Last-Modified headers, byte-range responses, suffix ranges, invalid-range guards, and versioned tile/viewer URLs so unchanged images and seekable previews can be served efficiently from the browser cache. Persistent app state is cached server-side with stat-key checks, a state-folder watcher, and periodic content-hash verification, and hot listing paths reuse a derived label map instead of reparsing and remapping `state.json` for every folder. Navigator tree and breadcrumb flyout loads use a fast tree mode that avoids per-child stat calls and child-folder probes; expanders are optimistic, then empty folders are remembered as leaves after the first expansion. Auto-refresh uses bounded server-side directory watchers as a cheap change detector and only falls back to full folder-signature scans when a watcher is unavailable, while still yielding to active pane loads instead of competing with explicit navigation. The file display avoids blocking on full DOM materialization for large folders: it paints an initial slice immediately, appends the rest in chunks, and keeps the full visible entry set available for keyboard navigation, selection, filters, and file operations. Very large Details, Compact, and Tile folders switch to a virtual window, keeping only the visible rows or tile grid rows plus overscan in the DOM while the full entry set remains available for keyboard navigation, typeahead, selection, filters, and file operations. Selection and focus changes patch rendered row state directly instead of forcing full pane rerenders, so clicking, range selection, typeahead, and arrow-key movement stay responsive in big folders. Each tab also caches its current filtered/sorted visible-entry snapshot and path index, then invalidates that cache when entries or pane filters change, avoiding repeated full-folder filter/sort work during navigation. Image tile thumbnails defer `/api/raw` work until their cells approach the viewport, and virtual/progressive render chunks hydrate only the thumbnail nodes they just mounted instead of rescanning the whole pane.

Benchmark and layout guardrails:

`verify:server-listing-cache` includes a cold duplicate-request herd to prove simultaneous pane/tab/script loads coalesce behind one server-side folder scan before warm-cache reuse and invalidation checks run.

```powershell
npm run perf:bench
npm run perf:bench:100k
npm run perf:guard
npm run verify:speed-health
npm run verify:startup-latency
npm run verify:goal
npm run verify:perf-100k
npm run verify:windows-baseline
npm run verify:mixed-load
npm run verify:operations
npm run verify:operation-preview-scale
npm run verify:power-tools-ui
npm run verify:operation-journal
npm run verify:operation-journal-concurrency
npm run verify:operation-journal-scale
npm run verify:operation-journal-retention
npm run verify:operation-cancel
npm run verify:operation-sync-cancel
npm run verify:operation-pause-resume
npm run verify:ops-recovery-ui
npm run verify:state-lock
npm run verify:state-corruption
npm run verify:crash-recovery
npm run verify:crash-kill
npm run verify:desktop-backend-recovery
npm run verify:elevation
npm run verify:elevation-ui
npm run verify:no-admin-access
npm run verify:path-diagnostics
npm run verify:real-paths
npm run verify:network-loopback
npm run verify:listing-cache-ui
npm run verify:listing-cache-eviction-ui
npm run verify:listing-prefetch-ui
npm run verify:rapid-navigation-ui
npm run verify:filesystem-objects
npm run verify:thumbnail-cache-ui
npm run verify:cache-maintenance
npm run verify:scripting-api
npm run verify:release-readiness
npm run verify:code-signing
npm run verify:production-signing
npm run verify:production-readiness
npm run verify:shell-rehearsal
npm run verify:shell-current-user
npm run verify:release-update-feed
npm run verify:release-update-feed-desktop
npm run verify:release-bundle
npm run verify:hosted-update-feed
npm run verify:external-proof
npm run verify:auto-update-feed
npm run verify:shell-verbs
npm run verify:shell-namespace
npm run verify:shell-devices
npm run verify:native-shell-readiness
npm run verify:shell
npm run verify:windows-recycle
npm run verify:zip-browse
npm run verify:background-index
npm run verify:background-index-freshness
npm run verify:background-index-watch
npm run verify:background-index-restart
npm run verify:background-index-isolation
npm run verify:background-index-concurrency
npm run verify:background-priority
npm run verify:background-index-cancel
npm run verify:speed-index-ui
npm run verify:search-background-ui
npm run verify:interaction-resize
npm run verify:layout
npm run verify:pane-layout-no-scrollbars
npm run verify:size-analysis-ui
npm run verify:size-analysis-perf
npm run verify:size-analysis-cancel
npm run verify:large-folder-ui
npm run verify:large-folder-100k-ui
npm run verify:keyboard-workflows-ui
npm run verify:accessibility
```

`perf:bench` records cold listing, warm listing, pane-style broad/narrow filter latency, live API search latency, folder-index build/search, background-index warm-cache search, optional background text-content indexing, optional network-path timings, and thumbnail-ish image metadata cache timings in `artifacts\perf-benchmark-latest.json` and `.md`. Use `EB_PERF_MEDIA_COUNTS=250,1000 npm run perf:bench` to scale the image-cache portion. Use `EB_PERF_CONTENT_COUNTS=1000,10000 npm run perf:bench` to scale opt-in background text-content indexing runs. Use `EB_PERF_NETWORK_PATHS="\\server\share|Z:\folder" npm run perf:bench` to include SMB/UNC or mapped-drive path timings when a network target is available. `perf:guard` runs a smaller benchmark and fails when cold/warm list, pane filter, API search, folder-index search, background-index search, image-cache, content-index, or configured network-path timings exceed budgets; it writes `artifacts\perf-guard-latest.json` and `.md`, appends trendable metrics to `artifacts\perf-trend-history.jsonl`, and writes `artifacts\perf-trend-latest.json` plus `.md` comparing the current run to historical medians. `verify:speed-health` consumes the latest startup, perf, 100k, Windows-native baseline, browser-cache, thumbnail, large-folder, network, background-index, Speed UI, and trend artifacts into one fast scorecard with hottest metrics and headroom in `artifacts\speed-health-latest.json` and `.md`. `verify:startup-latency` measures cold backend startup, `/api/roots` readiness, first HTML/CSS/JS responses, first folder list, browser DOMContentLoaded, and first visible file rows, then writes `artifacts\startup-latency-latest.json` and `.md`. `verify:listing-cache-ui` opens the browser UI, proves a cold pane reports `Filesystem`, double-clicks into a folder, returns through the path bar, and verifies the warm revisit paints from `Memory cache` with cached status text and unclipped Speed metrics. `verify:listing-cache-eviction-ui` churns through more folders than the frontend listing cache can hold, proves the oldest folder gets pruned and reloads from `Filesystem`, and proves the newest folder still reopens from `Memory cache` without another `/api/list` request. `verify:listing-prefetch-ui` hovers many folder rows, proves predictive prefetch stays inside the active request budget, then opens a warmed folder from `Memory cache` without issuing a second `/api/list` request. `verify:rapid-navigation-ui` opens the browser UI, delays an old `/api/list` response, proves the app attempted to abort that stale load, and verifies the final destination still owns the pane with Quick Search responsive afterward. `verify:thumbnail-cache-ui` opens the browser UI in tile mode, verifies virtualized image tiles load only a bounded set of visible thumbnails, scrolls to load more, and proves versioned `/api/raw` thumbnail responses are cache-friendly with immutable headers, conditional `304` support, byte-range `206` support, invalid-range guards, and repeated conditional requests. `verify:cache-maintenance` starts a temporary backend with seeded active, stale, orphaned, corrupt, and quarantined cache files, proves the maintenance API is dry-run by default, then applies cleanup while preserving active background roots and current warm caches. Budgets can be adjusted with `EB_PERF_GUARD_*`, `EB_STARTUP_*`, and the matching CLI flags; trend sensitivity can be adjusted with `EB_PERF_TREND_REGRESSION_FACTOR`, `EB_PERF_TREND_MIN_DELTA_MS`, and `EB_PERF_TREND_FAIL_ON_REGRESSION=1`. `verify:goal` audits the latest goal-critical artifacts across performance, background index/cache, shell coverage, operations, metadata cache, UAC, scripting, accessibility/layout, crash recovery, release readiness, and release integrity; it fails on missing/stale/failing evidence and warns for external proof still needed, such as an attached MTP device, signing certificate, or hosted update feed. `verify:perf-100k` runs the 100k-file stress path only, checks explicit cold/warm list, pane-filter, API search, folder-index, and background-index budgets, then writes `artifacts\perf-100k-latest.json` and `.md`. `verify:windows-baseline` compares generated 1k/10k/100k folders against Windows-native `.NET DirectoryInfo.EnumerateFileSystemInfos`, proving warm app listings reuse cache with zero scanned rows and active-index search scans only the narrowed candidate set while native enumeration scans the full folder. `verify:size-analysis-perf` builds a 10k Analyzer fixture, proves concurrent cold Analyzer requests coalesce into one filesystem walk, verifies foreground list, active-index search, and roots latency while an uncached Analyzer scan is running, then proves warm-cache reuse and operation-driven invalidation. `verify:size-analysis-cancel` starts duplicate Analyzer scans, aborts the origin request, proves the active duplicate restarts instead of inheriting the abort, checks foreground list/roots p95 latency after cancellation, and verifies the recovered scan warms the Analyzer cache. `verify:operations` starts a temporary backend and proves operation previews report copy, rename, overwrite, mirror-delete, and unsafe-path rejection without modifying fixture files. `verify:power-tools-ui` opens the browser UI and proves Flat View, Duplicate Finder, Compare, and selected sync preview work together from visible controls without applying or mutating fixture files. `verify:operation-journal` starts a temporary backend, runs real copy, move, permanent delete, app trash, rename, sync, create-file, undo, and retry-remaining operations, then proves persisted Ops rows include progress, result, undo, retry lineage, bounded history, and exact API/disk consistency. `verify:operation-journal-retention` seeds a saturated Ops history with an old recoverable failure outside the newest-row window, proves actionable recovery survives trimming before disposable completed rows, retries it, and keeps API/state history bounded. `verify:ops-recovery-ui` opens the browser UI against seeded interrupted copy/transfer/sync rows, proves the Ops dialog shows recovery details and retry affordances, clicks the selection controls and Retry Selected, then checks layout and disk results. `verify:state-lock` starts a temporary backend, applies an exclusive Windows file lock to `state.json`, writes state through the public API, and proves retry, persisted JSON readability, API/disk consistency, and temp-file cleanup. `verify:crash-recovery` starts a temporary backend with seeded interrupted queued/running/paused operations and proves they reopen as failed, retryable, interrupted Ops rows. `verify:crash-kill` starts a temporary backend, kills the real server process during checkpointed copy, move, permanent delete, app trash, sync, and rename operations, also kills during an atomic state save, then restarts and proves recovery metadata, undoability, remaining-work retry metadata, and state readability are sane. `verify:desktop-backend-recovery` starts the Electron shell, simulates an embedded backend listener failure, and proves the desktop bridge restarts the backend, reloads the renderer, and shows rows again. `verify:elevation` starts a temporary backend with failed copy/delete recovery rows, dry-runs an elevated plan, prepares a launch-free elevated helper package, verifies its manifest hash and UAC launcher script, and proves helper preparation does not mutate fixture files. `verify:path-diagnostics` starts a temporary backend and proves local folders, files, missing paths, and parse-only UNC paths return bounded path-health reports without requiring a real network share. `verify:real-paths` starts a temporary backend, discovers actual workspace, OneDrive/cloud, known-folder, drive, and explicit `EB_REAL_PATHS` targets, then runs bounded diagnostics, cold/warm listing, folder-index search, and shallow background-index search while reporting unavailable external targets without hanging. `verify:network-loopback` builds a bounded local fixture, reaches it through a loopback UNC path using an existing administrative share or temporary SMB share when Windows allows it, then proves path diagnostics classify it as network plus cold/warm listing and folder-index search work over UNC. `verify:filesystem-objects` starts a temporary backend, creates Windows `.lnk` shortcuts, NTFS hard links, junctions, and a symbolic-link attempt, verifies app listing/index/background-index link metadata, then undoes the created objects while proving sources remain intact. `verify:scripting-api` starts a temporary backend, runs a trusted script with active/other pane context and selected files, verifies progress/events/helper APIs, then opens the browser and proves a saved toolbar script executes with the same pane context. `build:icon` regenerates the branded Windows icon PNG/ICO assets used by desktop packaging. `verify:release-readiness` starts a temporary backend in native shell-open mode, generates the Explorer integration kit, validates registry/launcher/removal files, captures a Shell Backup restore file, checks package metadata, branded icon configuration, static update-feed artifacts, and desktop artifacts, runs the Electron bridge smoke, and writes `artifacts\release-readiness-latest.json` plus `.md` with hard failures separated from production warnings such as missing signing and hosted production auto-update configuration. `verify:release-integrity` hashes the setup installer, blockmap, unpacked executable, packaged app archive, icon packaging input, and packaged source inputs, then fails when artifacts are missing, empty, stale, or missing SHA-256 entries. `build:update-feed` and `verify:release-update-feed` generate `dist\update-feed\latest.yml`, hardlink or copy the setup installer and blockmap into that static feed folder, and verify electron-updater-compatible SHA-512 metadata. `verify:release-update-feed-desktop` serves the generated static feed locally and proves the desktop updater consumes its `latest.yml` and reports the current release as not available. `verify:auto-update-feed` starts a local generic future-version feed, forces dev-mode updater checks only for the smoke, and proves the desktop bridge can report an available version without downloading it; production release builds still need a real hosted feed URL. `verify:shell-rehearsal` starts a temporary backend with isolated `%LOCALAPPDATA%`, `%APPDATA%`, `%USERPROFILE%`, and OneDrive/Desktop paths, installs the packaged app copy, installs/removes Start Menu/Desktop shortcuts and the optional Win+E startup helper, checks generated registry files point at the installed app, captures a Shell Backup restore file, and intentionally skips HKCU registry imports. `verify:shell-current-user` imports the generated context-menu and default-folder handler files into the real current-user HKCU shell keys, verifies they enable Explore Better, runs the installed desktop handler against a real target folder in smoke mode, then restores the pre-trial registry snapshot and proves the before/after shell state matches. `verify:shell-verbs` starts a temporary backend, enumerates native Windows shell verbs for a real fixture file, and dry-runs one verb without launching or mutating anything. `verify:shell-namespace` starts a temporary backend, enumerates This PC through Windows Shell.Application, checks Network and Libraries return bounded structured reports even when a Windows provider is unavailable, proves Network is latency-bounded and warm-cached, proves at least one This PC item can open in a real pane, and dry-runs shell item handoff. `verify:shell-devices` starts a temporary backend, enumerates This PC for MTP/phone/camera-style shell devices, proves non-filesystem shell providers cannot be opened as normal pane folders, and browses/dry-runs a device target when one is attached. `verify:shell` starts a temporary backend, seeds a Windows Library file, proves Shell navigation exposes This PC, Libraries, Network, Recycle Bin, special folders, and library targets, and verifies shell-open IDs are allowlisted. `verify:windows-recycle` creates a temp file, sends only that file to Windows Recycle Bin, proves the in-app Recycle API can list and dry-run restore it, restores it through a recorded Ops row, and confirms it returns to disk. `verify:zip-browse` creates a nested ZIP fixture, proves the archive lists as a virtual pane root, drills into nested folders without extracting, and checks parent virtual paths and timing output. `verify:background-index` starts a temporary backend, builds a bounded recursive background index, and proves filename, label-note, and text-content searches hit the warm aggregate cache. `verify:background-index-restart` builds a background index with filename, label-note, and text-content hits, restarts the backend, and proves the saved warm search store still answers without a rebuild. `verify:background-index-cancel` starts a loaded recursive content index, cancels it before completion, proves no partial complete cache is exposed, then restarts and searches the rebuilt cache. `verify:speed-index-ui` drives the visible Speed panel in a browser, builds the active folder index, finds label-note metadata from the saved index, adds the active folder as a background root, finds nested text content from the warm background cache, and checks the Speed dialog layout. `verify:layout` opens the browser UI across desktop/tablet/mobile viewports with crowded long-name favorites, fails when header/root-strip, toolbar, or dock controls are unreachable, outside their containers, clipped, or squished, and proves row hit targets plus double-click folder navigation. `verify:large-folder-ui` opens a 10k-entry fixture in the browser, proves large-folder virtualization keeps rendered DOM rows bounded, checks header layout under stress, verifies client filtering and virtual scrolling, and writes screenshots plus `artifacts\large-folder-ui-latest.json`. `verify:large-folder-100k-ui` runs the same browser virtualization and filter path against a 100k-entry desktop fixture and writes `artifacts\large-folder-100k-ui-latest.json`. `verify:keyboard-workflows-ui` drives command-palette execution and Quick Search filtering from the keyboard, checks focus handoff and keyboard UI layout, and writes `artifacts\keyboard-workflows-ui-latest.json` plus `.md`. `verify:accessibility` opens desktop/mobile browser views, checks visible controls and dialogs for useful accessible names, verifies keyboard file-list navigation, confirms command-palette focus, and checks high-contrast focus styling.

The `/api/list` endpoint also accepts `offset` and `limit` for viewport-sized listing windows. Pane navigation uses that path for first paint, then hydrates the full listing under the same navigation so operations, filters, and selection keep full-folder behavior. `verify:windows-baseline` requires that the warm 100k folder cache can return the first 200-row window with zero scanned rows while still reporting the full total count, and the large-folder browser verifiers prove the UI paints that window before full-list hydration.

`verify:operation-preview-scale` builds large transfer and sync conflict fixtures, proves exact copy/rename/overwrite/skip/mirror-delete/missing-source/risky counts, verifies preview digests and latency budgets, and confirms preview calls do not mutate disk.

`verify:operation-cancel` cancels a live copy after checkpointed progress, proves the canceled row records only unfinished remaining work, retries that remaining work, and verifies the target folder has the exact file set without duplicate copies.

`verify:operation-sync-cancel` cancels a live sync after checkpointed progress, proves the canceled row records only unfinished sync items, retries that remaining work, and verifies the right pane has the exact synced contents.

`verify:operation-pause-resume` pauses a live copy after checkpointed progress, proves the target folder does not advance while paused, resumes the operation, and verifies the final target set plus persisted operation history.

`verify:state-corruption` corrupts isolated `state.json` profiles, proves restore from `state.json.bak`, proves no-backup fallback to defaults, avoids preserving corrupt backups, and verifies later saves heal the backup.

`verify:release-bundle` writes `dist\release-bundle-manifest.json` and `.md`, plus latest artifact copies, then cross-checks the current installer, blockmap, unpacked executable, app archive, update-feed assets, desktop updater smoke, code-signing rehearsal, current-user shell install/revert proof, and release readiness evidence as one publishable bundle.

`verify:production-signing` inspects the actual setup installer and unpacked desktop EXE with Windows Authenticode. With no expected certificate configured it records the production signing gap as a warning; with `EXPLORE_BETTER_SIGNING_THUMBPRINT`, `EB_SIGNING_THUMBPRINT`, `EXPLORE_BETTER_SIGNING_SUBJECT`, or `EB_SIGNING_SUBJECT`, it becomes strict and fails unless the signed targets match the expected production certificate and trusted signature chain.

`verify:production-readiness` reads the latest release-readiness, integrity, update-feed, updater, signing, shell, bundle, hosted-feed, and external-proof artifacts into `artifacts\production-readiness-latest.json` plus `.md`. It fails on local release evidence gaps, warns for outside-world blockers in advisory mode, and `-- --strict` makes missing production signing, hosted feed, or strict external proof fail.

`verify:hosted-update-feed` proves a production-hosted generic update feed when `EXPLORE_BETTER_UPDATE_URL` or `EB_UPDATE_URL` points at the feed base URL or `latest.yml`; with no URL configured it records the remaining hosted-feed gap as a warning. Use `EB_HOSTED_FEED_HASH_ASSETS=1` or `--hash-assets` when you want the verifier to download and hash the hosted installer and blockmap instead of checking the advertised metadata and asset headers only.

`verify:external-proof` refreshes code-signing rehearsal, static update feed generation, desktop update-feed smoke, release readiness, release integrity, release-bundle manifest, hardware, production-signing, and hosted-feed proofs together, then writes `artifacts\external-proof-latest.json` plus `.md`. Release-bundle, readiness, integrity, and generated feed failures are always hard failures because they mean the proof is stale or not publishable. Default mode is advisory only for outside-world assets; `npm run verify:external-proof -- --strict` fails until an attached phone/camera device is observed, the real production signing certificate is configured and trusted, and the hosted update feed matches the local release bundle.

`verify:shell-devices` records structured This PC, shell-only, portable-device, and Windows PnP/CIM hardware-snapshot evidence. With no phone/camera attached it proves pane safety, warm-cache behavior, simulated MTP browse safety, and what Windows currently reports for portable/camera candidates, then writes exact attachment instructions; use `npm run verify:shell-devices -- --require-device` to make physical MTP/phone/camera proof a hard gate, and add `--device-query="DEVICE NAME"` to target a specific attached device.

`verify:native-shell-readiness` reads the latest shell locations, namespace, device, verb, Recycle Bin, ZIP, filesystem-object, real-path, and network-loopback artifacts into `artifacts\native-shell-readiness-latest.json` plus `.md`. It fails on local native-shell evidence gaps, warns for missing attached phone/camera/MTP hardware in advisory mode, and `-- --strict` makes that hardware proof a hard gate.

Background folder scans use a lower-priority worker lane than foreground pane listings by default, so indexing can run without taking the whole stat pool away from active browsing. Tune foreground scans with `EXPLORE_BETTER_LIST_CONCURRENCY`, tune background folder scans with `EXPLORE_BETTER_BACKGROUND_LIST_CONCURRENCY`, and tune background text reads with `EXPLORE_BETTER_CONTENT_INDEX_CONCURRENCY` when benchmarking different disks. `verify:background-index-concurrency` builds a large background index, restarts the backend, fires a concurrent first-search herd, and proves duplicate store reads join one in-flight load before the warm cache takes over. `verify:background-priority` proves foreground folder indexes use the high lane while background indexes use the bounded lane and still return warm content hits. `verify:background-index-cancel` starts a loaded recursive content index, stops it while running, proves no partial complete cache is published, then restarts and searches the rebuilt warm cache. `verify:background-index-freshness` proves the warm cache reports external folder changes as stale, auto-starts root repair, then clears and finds the new file after rebuild. `verify:background-index-watch` proves bounded folder watchers can observe indexed-root changes, debounce create/delete/rename bursts into one rebuild, remove stale deleted and renamed search hits, resume after backend restart, and proactively rebuild before the next user search.

`verify:search-background-ui` drives the normal Search dialog in a browser, enables `Warm Cache`, proves indexed content and label-note results stay scoped to the dialog Root, and checks the Search dialog layout.

`verify:interaction-resize` is the browser interaction guard for the resizable shell: it drags the navigator, pane splitter, preview, command dock, and horizontal pane-row handles, verifies the geometry changes persist through `/api/state` and reload, and checks double-click folder open after resizing.

## Safety Notes

- The server binds to `127.0.0.1` by default.
- App Trash moves files to `%LOCALAPPDATA%\ExploreBetter\Trash` instead of permanently deleting them.
- Windows Recycle sends files through the current user's Windows Recycle Bin. The Trash Browser can list and restore current-user Recycle Bin items through the Windows shell namespace, while App Trash remains separate under `%LOCALAPPDATA%\ExploreBetter\Trash`.
- Permanent Delete removes files directly after a typed `DELETE` confirmation. It is recorded in `Ops`, but has no app-level or Windows Recycle Bin restore path.
- Failed copy, move, and permanent-delete operations with remaining-work recovery can prepare or launch an elevated helper from `Ops`. Helper packages are generated from structured retry metadata under `%LOCALAPPDATA%\ExploreBetter\Elevation`, include a manifest hash, and are launched through Windows UAC only when you click an elevated action.
- On startup, stale queued/running/paused operations from a previous app crash or restart are marked failed/interrupted in `Ops` with remaining-work retry data where it can be derived. Restart-derived completion lists are marked as unverified because the process may have stopped before its final audit write.
- Explorer integration is generated but not applied automatically. The in-app buttons import current-user `HKCU` registry files only after confirmation, and context-menu/default-handler installs first capture a Shell Backup restore file.
- `install-context-menu.reg` adds "Open in Explore Better" for folders and drives. `install-folder-default.reg` is closer to Explorer replacement mode because it changes the current-user default folder/drive open handler. `restore-previous-shell.reg` is generated from the latest Shell Backup snapshot and can restore the previous current-user Directory/Drive shell defaults and app-owned Explore Better shell verb state.
- The launcher opens Edge/Chrome in app-window mode when available, using `%LOCALAPPDATA%\ExploreBetter\AppWindowProfile`, and falls back to the default browser.
- Native Window mode opens the current-user installed app from `%LOCALAPPDATA%\ExploreBetter\App` first when available, then the packaged `dist\win-unpacked\Explore Better.exe`, then the optional Electron wrapper with an embedded backend when `npm install` has installed `node_modules\.bin\electron.cmd`; if none exist, the generated launcher falls back to app-window/browser behavior. When Native Window mode and an installed or packaged EXE are available, generated context-menu and default-folder registry files point directly at that EXE instead of routing through PowerShell.
- The Explorer Integration dialog controls how folders opened from Windows shell handlers land in Explore Better: replace left pane, replace right pane, replace active pane, or open a new tab in the active pane.
- `Install App` copies the unpacked desktop build into `%LOCALAPPDATA%\ExploreBetter\App` for stable current-user shell handlers. `Remove App` deletes only that installed app copy. `install-shortcuts.ps1` creates Start Menu/Desktop shortcuts when requested from the integration panel, and `remove-shortcuts.ps1` removes those current-user shortcuts without touching registry handlers. `Clean Integrations` removes Explore Better Start Menu/Desktop shortcuts, the optional Win+E startup helper, and app-owned folder/drive shell handlers while keeping the installed app copy.
- The optional Win+E helper uses a current-user Startup shortcut to a resident PowerShell hotkey listener. It is not installed automatically and can be removed from the integration panel.
- The script console and saved tools are intentionally powerful. Treat them like running local PowerShell scripts: only run code you trust.

## Command Palette

Use `Command` or `Ctrl+P` to search built-in file-manager actions, saved trusted tools, and saved trusted scripts from one grouped launcher. Arrow keys move the active result, `Enter` runs it, and saved custom hotkeys are shown beside matching commands so the palette can also teach shortcuts as you work.

## Tool Variables

Saved tools receive these environment variables:

- `EB_ACTIVE`: active pane path.
- `EB_OTHER`: other pane path.
- `EB_FIRST_SELECTED`: first selected item path.
- `EB_SELECTED_LINES`: selected item paths separated by newlines.
- `EB_SELECTED_JSON`: selected item paths as JSON.

Tool text can also use placeholders:

- `{active}`, `{other}`, `{first}`: shell-quoted paths.
- `{selected}`: shell-quoted selected paths.
- `{selectedLines}`, `{selectedJson}`: shell-quoted multi-value data.
- `{activeRaw}`, `{otherRaw}`, `{firstRaw}`: raw text.

## Tool Packages

Use `Tools` to export all saved trusted tools as an `explore-better.tools.v1` JSON package. Import accepts that package shape, a raw array of tools, or an object with a `commands` array. Imports are inert until a tool is explicitly run, and the import toggle can either merge by tool id or replace the saved tool list.

## Script Library

Use `Script` to save trusted JavaScript snippets that run against the active pane with `context.path`, `context.selectedPaths`, and the helper `api` methods listed above. Check `Toolbar` on a saved snippet to add it to the top command strip as a one-click `JS` button. Each script run is recorded in `Ops` with context, selection count, logs, bounded result preview, and optional progress. Long scripts can call `api.progress(...)`, `api.checkpoint()`, or `api.sleep(ms)` to stay responsive to Ops pause/cancel controls. Script packages export as `explore-better.scripts.v1` JSON and can be imported by merge or replace mode. Imported snippets are saved only after confirmation and remain inert until explicitly run.

## Configuration Backup

Use `Backup` to export a full `explore-better.config.v1` JSON package with the active layout, favorites, aliases, recent locations, basket contents, saved layouts, tab groups, collections, pane snapshots, labels, folder formats, display presets, filter presets, selection sets, sync profiles, Open With presets, search presets, select presets, bulk rename presets, trusted tools, trusted scripts, hotkeys, and settings. Import can merge by id/path or replace matching configuration sections, and imported packages are confirmed before they change local state.

## Preferences

Use `Prefs` to adjust daily-driver behavior in one place. Preferences control compact/comfortable/spacious density, normal startup panes, the Preview pane, app-trash confirmations, Auto Refresh, hidden/system item visibility, linked pane navigation, the default paste conflict policy, and the launch/shell-open defaults used by Explorer integration files. Startup can restore the last lister, open Home + Downloads, Workspace + Home, Documents + Downloads, or launch into a saved layout. If integration files already exist, changing launch or shell-open defaults regenerates them.

## Toolbar

Use `Toolbar` to choose which built-in command buttons are visible in the bottom command dock. Everything remains available from `Command`, but saved toolbar profiles can keep the dock focused on essentials, organization, or power tools. `Command`, `Prefs`, and `Toolbar` stay fixed so the full command surface is always recoverable.

## Search

The `Search` button opens a bounded recursive search against the active pane by default. Search criteria can combine filename text, text-file content, kind, file size, modified/created age, Windows attributes, hidden/system inclusion, and scan/result limits. When saved background-index roots exist, enable `Warm Cache` to query indexed filenames, metadata, labels, notes, attributes, and optional text content from the normal Search dialog without a live filesystem crawl; results stay scoped to the dialog Root. If sampled folder or file stamps show that a warm cache is stale, Search reports the stale state and starts a background repair for that root. Search presets save the full criteria set, including root, limits, and cache mode, and are included in configuration backups. Results are loaded into the active pane as a virtual result tab view, and the dialog keeps a result list with snippets for content matches. Double-click a result to reveal it in Explorer.

## Quick Edit

Use `Edit`, the preview-pane `Edit` button, or right-click `Quick Edit` to open the selected small text file in the built-in editor. Saves are recorded in `Ops` as undoable text-edit operations, so the previous file content can be restored from operation history.

## New File

Use `File` in a pane toolbar, `New File` in the dock, or right-click pane background `New File` to create an undoable text file in the active folder. Templates include empty, plain text, Markdown, JSON, JavaScript, and PowerShell. Existing names can stop the operation or create a unique copy-style name, and the new file can open directly in Quick Edit after creation.

## Shortcuts

Use `Shortcut`, the command palette `Create Windows shortcut`, or right-click `Create Shortcut Here` to create `.lnk` shortcuts for the active selection in the active folder. Existing names get unique copy-style names, and shortcut creation is recorded in `Ops` with undo.

## Filesystem Links

Use `Link`, the command palette `Create filesystem link`, or right-click `Create Link Here` to create hard links, junctions, or symbolic links for the active selection in the active folder. `Auto` uses hard links for files and junctions for folders, existing names can get unique copy-style names, and created links are recorded in `Ops` with undo. Optional Details columns show link type, hard-link count, and symlink/junction targets. Symbolic links may require Windows Developer Mode or elevated privileges.

## Open With

Use `Open With` from the dock or context menu to launch the active selection outside Explore Better. Quick actions open the default app, reveal the first target in Explorer, start a terminal at the selected folder or file parent, or open `Shell Verbs` for native Windows actions exposed by the selected file, folder, drive, sync provider, or installed shell extension. Custom launch supports an application path plus argument placeholders: `{path}`, `{paths}`, `{folder}`, `{name}`, and `{stem}`. Save frequent custom launchers as Open With presets with optional extension rules such as `.md`, `.png`, `folder`, or `*`; matching presets appear as quick launch buttons for the current selection and as one-click launchers in the row context menu.

## Operation Queue

The `Ops` dialog and dock readout update while work is queued, running, or paused. Rows show status, elapsed time, result counts, failures, pause/resume/cancel buttons for transfer work and cooperative scripts, retry buttons for recoverable failed or canceled file operations, and undo buttons for operations that can be reversed. Copy, cross-volume move, transfer, and sync actions report byte progress with transfer rate and ETA, while item-oriented actions and scripts still show current item and completed/total counts. Failed copy/move/delete/transfer/sync/trash/recycle rows keep recovery details for completed, failed, and remaining paths, can open a details dialog, can copy a recovery report to the Windows clipboard, can retry all remaining work, and can retry selected remaining items. Completed transfer/sync rows that overwrote destinations expose their App Trash backup items in the same details dialog, where selected backups can restore the original item or be discarded to keep the replacement. Retried and backup-recovery operations are recorded as their own rows and linked back through operation history, so recovery stays auditable instead of replacing history.

## Preview Pane

The inspector previews selected folders, text, images, PDFs, audio, and video without launching a separate app. Use `Viewer`, the preview-pane `Viewer` button, right-click `Open Viewer`, or `F3` to open text, images, PDFs, audio, and video in a larger modal viewer with previous/next navigation through the active pane's previewable files. Media and PDF previews stream through `/api/raw` with byte-range support so browser-native viewers can load metadata and seek within supported files.

## Flat View

Use `Flat` to recursively flatten the active folder into a virtual pane. It can show files, folders, or both, and it keeps scan/result limits plus optional hidden and heavy-folder toggles for large project trees.

## Duplicate Finder

Use `Dupes` to scan the active folder for duplicate files. Size Only mode groups exact byte-size matches quickly; SHA-256 mode hashes only same-size candidates to confirm real duplicates. Results are grouped in the dialog and opened into the active pane as a virtual view with parent paths preserved for preview and reveal workflows.

## Navigator

The left Navigator rail is built for repeated file-management work: favorites stay pinned, common Windows folders and drives are always available, the Shell section exposes This PC, Libraries, Network, Recycle Bin, App Trash, media folders, and discovered Windows Library targets, drive rows show free space and compact usage meters, the Folder Tree can expand live subfolders, and recently opened folders are recorded in `%LOCALAPPDATA%\ExploreBetter\state.json`. Click a real-folder row to open it in the active pane, use the `>` button to open it in the other pane, or use a shell-only row to hand off to the Windows shell namespace through an allowlisted backend opener. Use Shell `Browse` or the command palette's `Open shell browser` command to enumerate virtual Windows shell folders in-app; filesystem-backed shell items can open in the active pane, while virtual devices/providers can be browsed further or handed to Explorer. Use the Navigator `Edit` button or the command palette's `Open favorites manager` command to rename, recolor, reorder, delete, or open saved favorite paths. The `+` button still pins the active pane path immediately.

## Folder Aliases

Use `Aliases` to save short names for long folders. Alias names use letters, numbers, hyphens, or underscores, start with a letter, and appear in the path bar as `name:`. Suffixes are supported, so `proj:\src` opens the `src` child under the saved `proj:` path. Alias rows also appear in Navigator with the same active-pane and other-pane open controls as favorites.

## Folder Tree

Use the Folder Tree section in Navigator to expand drives, home, workspace, and common folders without leaving the current pane. The tree loads directory children on demand with a bounded result count, highlights the active pane path, supports opening a branch in the other pane, and can reveal or refresh the active folder from its header buttons. For speed, tree expanders are optimistic and avoid probing every child folder up front; empty folders are remembered as leaves after first expansion.

## Path Entry And Breadcrumbs

Each pane keeps the raw editable path field and adds a breadcrumb strip beneath it. Focus or type in a path field to get suggestions from aliases, favorites, common roots, recent folders, and matching child folders under the typed parent. `Tab` accepts the highlighted suggestion, `Enter` opens it, arrow keys move through candidates, and `Escape` closes the rail. Click any breadcrumb ancestor segment to jump there through the normal pane history path, or use the segment chevron to browse immediate child folders from that ancestor without leaving the current folder first. Breadcrumb child menus include an other-pane launcher for quick split-pane navigation. The path-bar `H` button, `Alt+Down`, or the command palette's `Open pane history` command opens a jump list for the active tab's back stack, current path, and forward stack.

## Locked Tabs

Use the `L` button on a pane tab, or the `Toggle tab lock` command, to park that tab on its current folder. Folder navigation from a locked tab opens the destination in a new unlocked tab beside it, including Back and Forward history moves, so project roots and reference folders stay anchored while exploration branches out. For ad hoc branching, right-click a folder and choose `Open Folder In New Tab`, press `Ctrl+Enter` on the focused folder, or middle-click a folder row. Tab muscle memory is supported with `Ctrl+T` to duplicate the current tab, `Ctrl+W` to close it, `Ctrl+Shift+T` to reopen the last closed tab, and `Ctrl+Tab` or `Ctrl+PageDown` / `Ctrl+PageUp` to cycle within the active pane.

## Status Summary

The footer summarizes the active pane at a glance. With nothing selected it reports visible item counts, file/folder mix, and known file bytes. With a selection it switches to selected item counts and selected file bytes, so copy, move, archive, trash, and label decisions have immediate context.

## Pane Filters

Each pane has independent text, kind, and label filters. Kind filters can narrow a busy folder to folders, files, images, text, documents, media, archives, or apps, and they persist with tabs, layouts, tab groups, folder formats, display presets, and pane snapshots. Use `Filters` to save or apply reusable text/kind/label combinations, and exported configuration backups include those filter presets.

## Shell Open Behavior

Use `Integrate` to choose how folders launched from the generated context menu, default-folder handler, shortcuts, launch test, or Win+E helper enter the lister. `Replace Left` keeps the original prototype behavior, while `Replace Active` and `New Active Tab` feel closer to a real daily-driver shell replacement. Launch Mode can use the Electron `Native Window`, Edge/Chrome `App Window`, or a regular browser tab. Native Window starts the backend inside the Electron process and prefers the current-user installed app, then the packaged `dist\win-unpacked\Explore Better.exe`, then the dev Electron launcher. The panel shows replacement readiness and a shell preflight across the generated kit, stable shell target, restore backup, current folder defaults, app shortcuts, context menu, default folder handler, and optional Win+E helper, plus the exact shell-handler target that the generated registry files will use. Normal startup preferences are skipped when a shell-open URL names a target folder or file with `open`, `shellPath`, `left`, or `right`, so Windows shell launches keep their requested destination; file targets open the containing folder and select the launched file. `Backup Now` captures current HKCU Directory/Drive shell state into `restore-previous-shell.reg`; context-menu/default-handler installs capture this automatically before importing registry changes. `Clean Integrations` is the current-user escape hatch for removing generated shortcuts, Win+E startup wiring, and Explore Better folder/drive shell handlers without deleting the installed app copy. Changing either launch setting regenerates existing integration launcher files so subsequent Windows shell opens use the saved mode.

## Layouts

Use `Layouts` to save the current two-pane workspace by name, restore a saved workspace, replace a saved workspace with the current panes, mark a saved workspace as the startup lister, or delete old layout snapshots. Layouts include the current pane arrangement: vertical split, horizontal split, or single active-pane focus. Layouts are stored locally in `%LOCALAPPDATA%\ExploreBetter\state.json`.

## Tab Groups

Use `Tab Groups` to save the active pane's current folder tabs as a reusable set. Restoring a tab group replaces only the active pane's tabs, keeps the opposite pane untouched, and preserves tab paths, history, view modes, details columns, filters, and locked-tab state.

## Pane Layout

Use the `V`, `H`, and `1` buttons in the dock to switch between side-by-side panes, stacked panes, and a single focused active pane. The hidden pane in single mode keeps its tabs, selection, history, and path intact. Keyboard shortcuts are `Ctrl+Shift+1`, `Ctrl+Shift+2`, and `Ctrl+Shift+3`.

## Collections

Use `Collections` to save arbitrary selected files or folders into named virtual groups. A collection can contain paths from many directories, open in the active pane, and keep missing items visible as unavailable rows instead of silently dropping them.

## File Basket

Use `Add Basket`, right-click `Add To Basket`, or the Basket dialog's `Add Selection` button to gather selected paths into a persistent scratchpad. `Basket` can open those paths as a virtual pane, copy or move the selected basket rows to the active folder, or send them to the Archive dialog as one batch. If no basket rows are checked, batch actions use the whole basket.

## Pane Snapshots

Use `Snapshots` to capture the active pane's current visible listing and selection as a frozen virtual view. Restoring a snapshot loads those captured rows into the active pane while preserving columns, sort, filter, label filter, view mode, and locked-tab state, and it leaves the other pane untouched.

## Labels

Use `Label` or `Labels` to attach local color labels and notes to selected files or folders. Labels are stored in `%LOCALAPPDATA%\ExploreBetter\state.json`, appear as badges in details, compact, tile, collection, search, and flat views, and can be filtered per pane with the label dropdown. Add the optional `Notes` Details column when you want those local comments visible beside the files instead of only in badge tooltips. App-managed copy, move, rename, bulk rename, transfer, sync, trash, and undo paths update label metadata so badges stay attached to the current path.

## Columns

Use `Cols` or `Columns` to choose the active tab's Details columns. The current choices are Name, Kind, Ext, Size, Dim, Attr, Link, Target, Modified, Created, Accessed, Label, Notes, and Parent. Column choices persist with layouts and duplicated tabs, and the dynamic headers can sort by the visible metadata columns.

## Folder Sizes

Use `Sizes` in a pane toolbar, the dock, the command palette, or the context menu to calculate recursive sizes for folders directly in the file pane. Selected folders are sized first; if nothing is selected, Explore Better sizes the visible folders in the active pane up to a bounded limit. Scanned folders show their total bytes in Details, compact, and tile views with file/folder counts in the hover text, and partial or unavailable scans are marked without touching the filesystem.

## Hidden Items And Attributes

Use the `Hidden` dock toggle or the command palette's `Toggle hidden items` command to show or hide hidden and system filesystem entries in real folder panes and the Navigator tree. The optional `Attr` Details column shows compact flags such as `R` for read-only, `H` for hidden, `S` for system, and `A` for archive. Compact and tile views include the same attribute text in their metadata line.

Use `Attributes`, the command palette's `Set file attributes`, or right-click `Attributes` to keep, set, or clear read-only, hidden, system, and archive flags for the active selection. Attribute changes run through `Ops` and can be undone back to each item's original flags.

## Timestamps

Use `Timestamps`, the command palette's `Set timestamps`, or right-click `Timestamps` to set modified, created, and accessed times for the active selection. Check only the fields you want to change, use `Now` when stamping to the current time, and undo from `Ops` to restore each item's original times.

## Folder Formats

Use `Fmt` or `Formats` to save the active tab's view recipe for the current folder. A format captures the view mode, sort key/direction, kind/label filters, and Details columns, then re-applies them automatically when a matching folder is opened. Match rules can target one exact folder or the whole subtree below it, and formats are stored locally in `%LOCALAPPDATA%\ExploreBetter\state.json`.

## Display Presets

Use `Presets` or the Display Presets section inside `Formats` to save the active tab's view recipe without a folder path. Presets capture the same view mode, sort key/direction, kind/label filters, and Details columns as Folder Formats, but apply on demand to whichever pane is active. Use Filter Presets when you only want to save the narrowing rule without changing the pane's columns, sorting, or view mode.

## Clipboard

Use `Cut`, `Copy`, and `Paste` in the dock, or `Ctrl+C`, `Ctrl+X`, and `Ctrl+V`, for file clipboard operations. Cut and Copy keep the app's visible clipboard state and also publish a Windows FileDrop clipboard payload, so files copied here can be pasted in Explorer and files copied in Explorer can be pasted back into Explore Better. The compact policy menu beside `Paste` controls conflicts for regular paste: `Rename`, `Overwrite`, or `Skip`. Paste targets the active pane folder, copy keeps the clipboard for repeated pastes, and cut moves clear the clipboard after a successful paste. Clipboard operations run through the same transfer operation queue as the rest of the app, so they appear in Ops and keep undo metadata, including overwrite backups.

Use `Names` or right-click `Copy Names` when you want text on the Windows clipboard instead of a file-transfer clipboard. Formats include full paths, names, stems, parent folders, JSON arrays, and CSV rows, with separator and quote controls plus a live preview before copying.

## Auto Refresh

Keep `Auto` enabled in the dock to refresh visible filesystem panes when files are created, deleted, renamed, resized, or modified outside Explore Better. The app polls a lightweight folder signature instead of reloading full listings every tick, skips virtual result panes, and preserves still-existing selections during automatic refresh.

## Linked Panes

Enable `Link` in the dock when the left and right panes are parked on matching folder trees. Drilling into a child folder, moving back up, or switching to a sibling folder in one pane attempts the same relative navigation in the other pane. If the matching folder does not exist, the other pane is left where it is.

## App Trash

Use `Trash Bin` to inspect files and folders moved into `%LOCALAPPDATA%\ExploreBetter\Trash` and to browse the current Windows Recycle Bin without leaving the app. App Trash entries can be restored into the active pane with unique destination names when needed, or permanently deleted from the app trash after confirmation. Windows Recycle entries restore through the native shell namespace back to their original locations and are recorded in `Ops`; app-trash restores can be undone back into the app trash.

Use `Recycle`, the context menu `Recycle In Windows`, or `Ctrl+Delete` to send the active selection to the Windows Recycle Bin. These operations are recorded in `Ops` and can retry remaining items after partial failure, but app-level undo is not available because restoration belongs to Windows.

Use `Delete`, the context menu `Delete Permanently`, or `Shift+Delete` for direct permanent deletion. The app requires typing `DELETE` before it runs the operation, records the deletion in `Ops`, and can retry remaining paths if a partial delete fails. Deleted items cannot be restored from App Trash or the Windows Recycle Bin.

## Context Menus

Right-click a file or folder row to open a compact command menu for open, matched Open With preset launchers, open in the other pane, reveal, clipboard, copy/move to other pane, Send To destination picking, transfer, rename, shortcut creation, filesystem link creation, archive, labels, collections, basket, folder sizes, app properties, attribute edits, timestamp edits, Windows Properties, advanced selection, selection sets, and app trash. Right-click pane background to paste, create folders, refresh, calculate visible folder sizes, inspect folder properties, open Windows folder properties, add the folder to favorites, search, use flat view, advanced-select visible items, selection sets, or adjust columns, folder formats, and display presets.

## Drag And Drop

Drag selected rows or tiles from either pane and drop them onto a pane to copy into that folder. Hold Shift while dropping to move instead. In the Electron desktop app, files and folders dragged in from Windows Explorer or the desktop can be dropped onto a pane the same way; the preload bridge resolves native file paths and then sends them through the normal transfer queue. Desktop builds also start a native Windows file drag for selected rows, so selections can be dragged out to Explorer, the desktop, or other apps that accept file drops. App-managed drops use the same copy/move operations as the toolbar, clipboard, and context menus, so completed drops appear in Ops and can be undone.

## Advanced Select

Use `Select` or `Ctrl+Shift+M` to select visible items in the active pane. Wildcard masks like `*.jpg;*.png` can be combined with files/folders scope, size rules, modified/created age rules, and Windows attributes such as hidden, system, archive, compressed, encrypted, or read-only. Matching rows can replace the selection, add to it, remove from it, or keep only matching selected items. Save frequent rule sets as Select Presets, then apply them later in one click; presets are included in configuration backups.

## Selection Sets

Use `Sets` from the dock, command palette, or context menu to save the active pane's exact selected paths. Saved sets show how many saved paths are visible in the current pane, can be applied in replace/add/remove/keep modes, and can reopen their original folder before selecting. Selection sets persist in local state and are included in configuration backups.

## Keyboard

The active pane supports Explorer-style selection and operation keys: arrow/Home/End/Page keys move focus, typing printable characters in the focused file list jumps to matching visible names, repeated single-character typing cycles through same-letter matches, Shift extends selection ranges, Ctrl+A selects all visible items, Ctrl+C copies to the app and Windows file clipboard, Ctrl+X cuts to the app and Windows file clipboard, Ctrl+V pastes into the active folder, Ctrl+I inverts selection, Escape clears selection, Enter opens the focused item, Backspace goes up, Alt+Left/Right uses history, Alt+Down opens the pane history jump list, Alt+Enter opens the native Windows property sheet, F2 starts inline rename, F3 opens the Viewer, F5 copies to the other pane, F6 moves to the other pane, Delete moves items to app trash, Ctrl+Delete sends items to the Windows Recycle Bin, Shift+Delete permanently deletes after typed confirmation, Ctrl+L focuses the path bar, Ctrl+F focuses the filter, Ctrl+Shift+M opens Advanced Select, Ctrl+Shift+1/2/3 changes pane layout, Ctrl+Shift+L opens Labels, and Ctrl+Shift+V cycles details/compact/tile views.

Use `Hotkeys` to add custom app-level shortcuts for built-in commands, saved trusted tools, or saved trusted scripts. Custom hotkeys are stored in `%LOCALAPPDATA%\ExploreBetter\state.json`, can intentionally override defaults such as `Ctrl+P`, and do not fire while typing into inputs or while a modal dialog is open.

## Properties

Use `Properties` to inspect the active selection, or the active folder when nothing is selected. It computes bounded recursive folder sizes, file/folder counts, timestamps, skipped/truncated scan status, and optional SHA-256/SHA-1/MD5 file hashes with a configurable size cap. Use `Diagnose` in the same dialog to run a bounded Path Health check that classifies local, UNC, and mapped-drive paths, times stat/read/watch probes, reports drive space when available, and recommends warm indexing or fallback refresh behavior for slow or unavailable targets. Use `Win Props`, right-click `Windows Properties`, or `Alt+Enter` when you want the native Windows shell property sheet for the first selected item, focused item, or active folder.

## Checksums

Use `Hashes`, right-click `Create Checksums`, or the command palette's `Create checksum manifest` to hash selected files. Choose SHA-256, SHA-1, or MD5, set a max file size, then copy the generated manifest to the Windows clipboard or download manifest, CSV, or JSON output. Select a manifest, CSV, or JSON checksum file and use `Verify` or right-click `Verify Checksums` to hash the referenced files beside the manifest and report OK, mismatch, missing, and skipped rows. Folders and over-cap files are shown as skipped instead of being hashed recursively.

## Rename

Use `Rename`, right-click `Rename`, or `F2` to edit the focused filename directly inside the pane. `Enter` commits through the undoable operation queue, `Escape` cancels, and leaving the field commits the edit. For files, the stem is selected first so a quick typed replacement keeps the extension.

## Bulk Rename

Select files or folders and use `Bulk` or `Bulk Rename` to preview batch rename rules before anything touches disk. The current tool supports find/replace, optional regex, prefix/suffix, case conversion, numbering, and extension preservation. Save frequent rule sets as rename presets, then apply or replace them from the same dialog; presets are included in configuration backups. Apply runs through the operation queue and can be undone from the Ops dialog.

## Transfer

Use `Send To` from the dock, command palette, pane toolbar, or right-click menu when you already know where selected items should go. The destination picker starts with the other pane, then lists the active folder, parent folder, managed favorites, aliases, recent folders, common shortcuts, and drives. Choose Copy or Move plus Rename, Overwrite, or Skip, then send immediately; if the quick preview finds blockers, multiple selected items, folders, existing destinations, or overwrite risk, it opens the full Transfer dialog with the same target and policy.

Use `Transfer` when simple Copy/Move is too blunt. It previews the selected items against a target folder and lets you choose a global conflict policy: rename to a unique destination, overwrite, or skip. The summary calls out planned copy, move, rename, overwrite, skip, unchanged, and risky counts before Apply is enabled. Rows with existing destinations also expose per-item policy overrides, so one transfer can rename one conflict, overwrite another, and skip a third. Apply sends the preview digest back to the backend; if source or destination metadata changed after preview, the operation is rejected with a refresh-preview error before it mutates disk. Overwrites are first backed up into `%LOCALAPPDATA%\ExploreBetter\Trash`; applied transfers can be undone from the Ops dialog, or individual overwritten backups can be restored/discarded from operation details.

## Archives

Double-click a `.zip` file in a real folder pane to browse it as a read-only virtual folder. Folders inside the archive open in the same pane and support Back, Forward, Up, breadcrumbs, refresh, filters, sort, and the normal large-list renderer without extracting the archive. Use `Archive` to create a `.zip` from the active selection or extract the selected `.zip` into a new folder. Archive create/extract operations are recorded in Ops and can be undone, which moves the generated ZIP or extracted folder into app trash.

## Compare And Sync

The `Compare` button compares the left and right pane folders. By default it shows differences only and preselects rows that are natural left-to-right candidates. Save frequent folder pairs and options as Sync Profiles, then apply them later before comparing. Use `Plan L->R` or `Plan R->L` to generate an exact sync plan first; it lists copy, overwrite, skip, missing-source, mirror-delete, and risky counts without changing either folder. `Apply Sync` stays disabled until a current plan exists and sends that plan digest back to the backend; if source or destination metadata changed after planning, sync is rejected with a refresh-preview error before it mutates disk. If overwrite is enabled, replaced destination items are first moved into `%LOCALAPPDATA%\ExploreBetter\Trash` as sync backups so the operation can be undone from the Ops dialog or recovered per item from operation details. Enable `Mirror extras` when a selected row exists only on the destination side and should be moved into App Trash as part of the same sync operation; undo restores those mirrored extras too.

## Likely Next Steps

- Add production distribution pieces that require external assets: code-signing certificate, signed installer release, and a hosted update-feed URL for the generated static feed.
- Run a clean-machine shell-replacement rehearsal that imports, exercises, restores, and removes current-user context-menu/default-folder registry handlers after taking a system restore/snapshot backup.
