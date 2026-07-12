# Explore Better User Manual

Explore Better is a local dual-pane Windows file manager for power users. It is built for fast folder browsing, tabbed workflows, bulk file operations, previewing, scripting, and optional Explorer-style shell integration.

## Starting The App

From the project folder:

```powershell
npm start
```

Open `http://127.0.0.1:4627`.

For the desktop wrapper:

```powershell
npm run desktop
```

For the portable Windows build, run:

```powershell
npm run build:icon
npm run package:win
```

Then launch the generated portable executable from `dist`.

For an unsigned installer build:

```powershell
npm run build:icon
npm run package:installer
```

For release readiness before shell-replacement testing:

```powershell
npm run verify:release-readiness
```

For release integrity before sharing a build:

```powershell
npm run verify:release-integrity
```

For a consolidated bundle manifest before publishing:

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

For an isolated shell-replacement rehearsal:

```powershell
npm run verify:shell-rehearsal
```

## Main Window

The window has five main regions:

- Navigator: favorites, aliases, Windows Shell locations, drives, folder tree, and recent folders.
- Left pane and right pane: independent file listings with tabs.
- Preview: inspector for selected files and folders.
- Command dock: global tools such as Search, Analyzer, Compare, Transfer, Layouts, Tools, Script, and Integration.
- Status bar: load status, operation count, clipboard state, selection size, and folder load timing.

Drag the separators between Navigator, panes, and Preview to resize them. In horizontal split mode, drag the separator between the upper and lower panes. Drag the top edge of the command dock to make the command area taller or shorter. Sizes are saved automatically.

## Basic Browsing

- Single-click a file or folder to select it.
- Double-click a folder to open it.
- Double-click a `.zip` file to browse it as a read-only virtual folder.
- Double-click a file to open it with the default app.
- Turn on single-click opening in `Prefs` if you prefer web-style opening.
- Alt+double-click a folder to open it in the other pane.
- Press `Enter` to open the focused item.
- Press `Backspace` or the `..` button to go up.
- Use `Alt+Left` and `Alt+Right` for pane history.
- Use the path bar to type or paste a folder path.
- Use breadcrumbs under the path bar to jump to parent folders.
- Use Navigator Shell rows for This PC, Libraries, Network, Recycle Bin, App Trash, media folders, and discovered Windows Libraries.
- Use the Shell `Browse` button or command palette `Open shell browser` to inspect virtual shell locations in-app. Real filesystem items can open in the active pane; virtual devices, libraries, and network providers can be browsed further or opened through Explorer.
- Windows compatibility junctions such as `Documents\My Videos`, `Documents\My Pictures`, and `Documents\My Music` redirect to the real known folders when possible. If Windows blocks a genuinely protected folder, the pane shows an access note instead of forcing the whole app to run as administrator.

Each pane has its own tabs, path, history, filters, columns, sort order, and view mode.

## Tabs And Layouts

- `Ctrl+T`: duplicate the active tab.
- `Ctrl+W`: close the active tab.
- `Ctrl+Shift+T`: reopen the last closed tab.
- `Ctrl+Tab`: cycle tabs.
- Drag tabs left or right to reorder them.
- `L` on a tab locks it; navigating from a locked tab opens a branch tab.
- Use `Layouts` to save and restore a full two-pane workspace.
- Use `Tab Groups` to save only the active pane's tab set.
- Use the `V`, `H`, and `1` layout buttons for vertical split, horizontal split, and single-pane focus.

## Filtering And Views

Use the filter box in each pane to narrow visible items by name. The kind and label dropdowns further restrict the pane.

View buttons:

- `D`: Details view.
- `C`: Compact view.
- `T`: Tile view with lazy image thumbnails.

Use `Cols` or `Columns` to choose Details columns such as Size, Dim, Attr, Link, Target, Label, Notes, Parent, and timestamps. Drag a Details header edge to resize a column; widths are saved with tabs, layouts, folder formats, and display presets. Right-click a Details header to autosize, show/hide columns, reset widths, apply presets such as Media or Code, sort, or save a folder format.

Use `Quick` or `Ctrl+F` for inline search in the active folder. The Filter tab narrows the visible list as you type. The Jump tab keeps the list intact and moves through matches with Enter, arrow buttons, or `F3`.

Use `Speed` to inspect live active-pane load telemetry, then build a persistent folder index for the active pane. The live cells show source, item counts, total load time, read/stat/filter/label timing, worker count, and metadata mode. The index stores compact filename and metadata rows under `%LOCALAPPDATA%\ExploreBetter\Index`, then searches that warm cache instantly without rescanning the folder. Enable `Warm image metadata` when you want image dimensions cached under `%LOCALAPPDATA%\ExploreBetter\MetadataCache\Dimensions`; enable `Warm link targets` when a code or system folder needs link metadata cached too.

Use `Add Active` in the Speed dialog to keep the active folder as a bounded recursive background index root. Background search looks across saved roots from the warm aggregate cache and includes filenames, metadata, labels, label notes, and optional bounded text-file contents when `Index text content` is enabled. The normal `Search` dialog can use the same cache with `Warm Cache`, while still respecting the dialog Root and supported filters. If sampled folder or file stamps change after indexing, Speed and Search mark the cache stale and automatically start a bounded rebuild for the affected root; bounded folder watchers also watch indexed folders, resume after backend restart, and can start that repair proactively after disk changes. Explore Better operations and trusted script helper mutations also proactively queue matching background-index rebuilds, even when index watchers are disabled, so app-created/copied/moved/renamed/deleted/script-written content becomes searchable without waiting for the next freshness scan.

App-owned create, copy, move, rename, delete, and sync operations actively invalidate warmed folder listings before the next pane refresh, so fast cached navigation does not show stale rows while waiting for Windows watcher events. Warm server listing hits also validate a cheap directory stamp, so a missed watcher event cannot silently reuse stale rows. `npm run verify:operation-listing-cache` and `npm run verify:server-listing-cache` prove those paths.

Use `Properties` > `Diagnose` when a local folder, UNC share, VPN path, or mapped drive feels slow or unavailable. Path Health classifies the target, checks reachability with bounded timeouts, samples directory reads, reports watcher and drive-space status where possible, and suggests warm indexing or refresh fallback behavior.

## File Operations

Common actions are available from pane toolbars, the command dock, right-click menus, and keyboard shortcuts:

- `Ctrl+C`, `Ctrl+X`, `Ctrl+V`: copy, cut, paste.
- `F2`: inline rename.
- `Delete`: move to app trash.
- `Ctrl+Delete`: send to Windows Recycle Bin.
- `Shift+Delete`: permanent delete after typed confirmation.
- `F5`: copy selected items to the other pane.
- `F6`: move selected items to the other pane.
- `Alt+Enter`: Windows Properties.

Use `Open With` or right-click `Shell Verbs` to access native Windows actions exposed by the selected filesystem item, including app-specific print/edit/share/sync-provider verbs when Windows provides them.

Use `Transfer` for conflict-aware copy/move with rename, overwrite, and skip decisions. Use `Send To` for quick destination picking. Multi-item, folder, existing-destination, and overwrite-risk cases open a preflight plan before anything changes on disk. Apply is tied to the exact preview shown; if source or destination metadata changes after preview, Explore Better asks for a fresh preview before it mutates disk.

Operations appear in `Ops`, where supported work can be paused, resumed, retried, canceled, inspected, elevated, or undone. If a copy, move, or permanent delete fails because Windows requires administrator rights, open `Ops`, inspect the failed operation, and use `Elevate Remaining`, `Elevate Selected`, or `Elevate All` to launch a structured UAC helper for the remaining paths.

## Search, Compare, And Bulk Tools

- `Search`: bounded recursive filename/content search with filters, plus `Warm Cache` mode for querying saved background-index roots without a live crawl.
- `Flat`: flatten a folder tree into one virtual pane.
- `Dupes`: find same-size or hash-confirmed duplicate files.
- `Compare`: compare left and right panes, plan selected sync differences, then apply the current plan.
- `Bulk Rename`: preview and apply batch rename rules.
- `Hashes`: create or verify checksum manifests.
- `Archive`: create ZIP files or extract selected ZIPs. Double-clicking a ZIP opens it for read-only browsing in the pane.
- `Sizes`: calculate recursive folder sizes.
- `Analyzer`: scan a folder or selected item for logical bytes, allocated-size estimates, drive used/free context, a scan-complete strip with extension color bands, a folder tree with percent-of-parent bars, a file-type chart with color swatches and categories, top files, and a WizTree-style colored file map. Hover a map block to see the exact file/type/logical/allocated size share; click a concrete file block to open its parent in the active pane and select it. Duplicate cold scans of the same target coalesce into one filesystem walk, repeat scans of the same unchanged target use a short warm cache, and app file operations/scripts invalidate matching analyzer cache entries before the next scan. Use `Active` to load the active pane path, adjust the entry cap for huge trees, and leave `Follow links` off unless you intentionally want junctions/symlinks traversed.

Virtual result panes behave like normal panes for preview, selection, reveal, and many file operations. ZIP virtual panes are read-only until you extract the archive.

In `Compare`, use `Plan L->R` or `Plan R->L` before syncing. The preview lists copy, overwrite, skip, missing-source, mirror-delete, and risky counts without changing either folder, and `Apply Sync` stays disabled until a current plan exists. Sync Apply is also tied to that exact plan, so changed source or destination metadata forces a fresh plan before disk changes begin.

## Organization

- `Favorites`: saved locations in the Navigator.
- `Aliases`: short path prefixes such as `proj:`.
- `Collections`: saved groups of paths from many folders.
- `Basket`: scratchpad for gathering files before one batch action.
- `Snapshots`: frozen pane listings that can be restored later.
- `Labels`: local color labels and notes attached to paths.
- `Formats`: folder-specific view recipes.
- `Presets`: reusable display/filter recipes.
- `Sets`: saved exact selections.

Use `Backup` to export or restore configuration packages.

## Preview And Editing

The inspector previews folders, text, images, PDFs, audio, and video. Use `Viewer` for a larger preview window with neighboring-file navigation. Use `Edit` for quick editing of small text files with undoable saves.

## Scripting And Tools

Use `Tools` to save trusted shell commands. Use `Script` to save trusted JavaScript snippets with helper APIs for listing, copy, move, rename, trash, writing text, progress checkpoints, and emitted audit events. Scripts receive `context.path`, `context.activePane`, `context.otherPath`, `context.selectedPaths`, and `context.panes.left/right` so toolbar scripts can act on the same dual-pane workspace as built-in commands. Script helper mutations invalidate warm folder listings and matching background indexes the same way built-in operations do, so scripted workflows do not leave stale fast-cache results behind.

Saved tools and scripts can appear in the command strip and command palette. Treat them like local scripts: only run code you trust.

Drag built-in command dock buttons to reorder them. Use `Toolbar` to decide which buttons are visible.

## Explorer Integration

Use `Integrate` to generate or inspect Explorer replacement files, context-menu handlers, default folder handlers, shortcuts, native-window launch settings, and cleanup tools. Integration is current-user scoped and reversible through the generated restore/cleanup actions.

Run `npm run build:icon` before packaging if icon source changed. It regenerates the branded Windows PNG/ICO assets used by the desktop build.

Run `npm run verify:release-readiness` before treating a build as releasable. It validates package metadata, branded Windows icon configuration, installer-target configuration, generated launcher/registry/removal files, Shell Backup restore generation, native shell-target readiness, static update-feed artifacts, the updater runtime bridge, and the Electron bridge, then reports remaining production warnings such as unsigned builds and missing hosted production update feeds.

Run `npm run verify:release-integrity` after packaging. It writes a SHA-256 manifest for the setup installer, installer blockmap, unpacked executable, packaged app archive, and packaged source inputs, and it fails when release artifacts are missing, empty, stale, or missing hashes.

Run `npm run verify:code-signing` after packaging to rehearse signing a copied setup installer with a temporary CurrentUser code-signing certificate. The rehearsal verifies signer metadata, proves the original installer hash is unchanged, and removes the temporary certificate before it exits. Production still needs a real code-signing certificate.

Run `npm run verify:production-signing` after packaging when a real certificate is available. With no expected certificate configured it records the production signing gap as a warning; with `EXPLORE_BETTER_SIGNING_THUMBPRINT`, `EB_SIGNING_THUMBPRINT`, `EXPLORE_BETTER_SIGNING_SUBJECT`, or `EB_SIGNING_SUBJECT`, it verifies the actual setup installer and unpacked desktop executable are signed by the expected certificate and have a trusted signature chain.

Run `npm run verify:production-readiness` when you want one release/publish checklist. It reads the latest release-readiness, integrity, update-feed, updater, signing, shell, bundle, hosted-feed, and external-proof artifacts, then writes `artifacts\production-readiness-latest.json` plus `.md`. Local release evidence gaps fail; missing production signing, hosted feed, or strict external proof are warnings in advisory mode and failures with `-- --strict`.

Run `npm run build:update-feed` or `npm run verify:release-update-feed` after packaging to generate `dist\update-feed\latest.yml` plus the setup installer and blockmap assets that can be uploaded to a static generic update feed.

Run `npm run verify:release-update-feed-desktop` after generating the feed to serve `dist\update-feed` locally and prove the desktop updater can consume that exact `latest.yml`. Because it is the current app version, the expected result is `not-available`.

Run `npm run verify:release-bundle` after the release feed, desktop update smoke, code-signing rehearsal, shell proof, and readiness checks. It writes `dist\release-bundle-manifest.json` and `.md`, then verifies that the installer, blockmap, unpacked executable, app archive, update-feed assets, signing rehearsal, shell install/revert proof, and readiness report all describe the same current build.

Run `npm run verify:hosted-update-feed` after configuring `EXPLORE_BETTER_UPDATE_URL` or `EB_UPDATE_URL` to a hosted feed base URL or `latest.yml` URL. It fetches the hosted `latest.yml`, verifies it matches the local release bundle, probes the hosted installer and blockmap asset sizes, and can download/hash both hosted assets when `EB_HOSTED_FEED_HASH_ASSETS=1` or `--hash-assets` is used.

Run `npm run verify:external-proof` to refresh release-bundle prerequisites and summarize the three external production proofs in one artifact: attached phone/camera shell device, production Authenticode signing, and hosted update feed. Release-bundle, readiness, integrity, and generated update-feed failures are hard failures because they mean the proof is stale or not publishable. Default mode records warnings for missing outside-world assets; `npm run verify:external-proof -- --strict` turns those warnings into a hard certification gate.

Run `npm run verify:native-shell-readiness` when you want one native-shell checklist. It reads the latest shell locations, namespace, device, verb, Recycle Bin, ZIP, filesystem-object, real-path, and network-loopback artifacts, then writes `artifacts\native-shell-readiness-latest.json` plus `.md`. Local shell evidence gaps fail; missing attached phone/camera/MTP hardware is a warning in advisory mode and a failure with `-- --strict`.

Run `npm run verify:auto-update-feed` to start a local generic update feed and prove the desktop updater bridge can check a configured feed and report an available version without downloading it.

The desktop updater bridge is disabled until an update feed is configured with `EXPLORE_BETTER_UPDATE_URL` or `EB_UPDATE_URL`. With no feed, desktop smoke tests still verify that update status is callable but no network update check is attempted. Production builds still need a real hosted update feed.

Run `npm run verify:shell-rehearsal` to test the install/remove mechanics under isolated temporary `%LOCALAPPDATA%`, `%APPDATA%`, `%USERPROFILE%`, and OneDrive/Desktop paths. It installs the packaged app copy, installs/removes Start Menu/Desktop shortcuts and the optional Win+E startup helper, checks generated registry files target the installed app, and intentionally does not import HKCU registry files into the real shell.

Run `npm run verify:shell-current-user` to perform a real current-user HKCU shell-handler install/revert trial. It uses isolated app-data folders for the generated files and app copy, imports the generated context-menu and default-folder handler files into the real current-user shell keys, verifies Explore Better is enabled, runs the installed desktop handler against a real target folder in smoke mode, then restores the pre-trial shell registry snapshot before exiting.

## Performance Notes

Explore Better prioritizes fast browsing:

- Folder listing uses bounded concurrent metadata work.
- Unchanged foreground directory revisits can return from a watcher-validated server listing cache, including thumbnail/image-dimension and link-metadata variants, so very large folders avoid repeated `stat` scans while still invalidating after disk changes.
- Expensive metadata is loaded only when visible columns or filters need it.
- Large folders render progressively and virtualize very large views.
- Folder focus and hover can prefetch the likely next folder into the listing cache, with a small active-request limit so prefetch does not crowd out the folder you actually open.
- Stale loads are aborted, and late list responses are ignored, so fast navigation does not wait for or repaint old folders.
- The status bar and Speed panel show live folder load timing and phase telemetry.
- Warm revisits render from the in-memory listing cache and show `Memory cache` in Speed.
- The listing cache is short-lived, bounded, and least-recently-used, so fast revisits stay instant without letting long browsing sessions grow memory forever.
- `Speed` builds a persistent per-folder index for instant warm-cache filename and metadata searches.
- Tile thumbnails load lazily from versioned raw URLs, so image-heavy folders only request visible thumbnail windows and can reuse browser cache.
- Shell Browser namespace reads use bounded provider timeouts and short warm caching so slow Network providers do not repeatedly stall browsing.
- Tile thumbnails and viewer thumbnails use versioned raw-file URLs so unchanged images can reuse browser cache entries.
- `npm run perf:bench` measures cold list, warm list, pane-style filter latency, live search latency, folder-index search, background-index search, opt-in background text-content indexing, optional network-path timings, and thumbnail-ish image metadata cache timings.
- `npm run perf:guard` runs a smaller repeatable benchmark and fails when core speed budgets are exceeded. It writes `artifacts\perf-guard-latest.json` and `.md`, appends trendable metrics to `artifacts\perf-trend-history.jsonl`, and writes `artifacts\perf-trend-latest.json` plus `.md` so regressions are visible against historical medians.
- `npm run verify:speed-health` reads the latest speed evidence and writes one scorecard for startup, 100k stress, Windows-native enumeration baseline, server listing cache, browser cache, thumbnails, large folders, UNC paths, background indexes, visible Speed/Search UI, and trend headroom.
- `npm run verify:startup-latency` measures cold backend startup, `/api/roots` readiness, first HTML/CSS/JS responses, first folder list, browser DOMContentLoaded, and first visible file rows.
- `npm run verify:goal` audits the latest goal-critical artifacts across performance, background index/cache, native shell coverage, operations, metadata cache, UAC, scripting, accessibility/layout, crash recovery, release readiness, and release integrity. It fails on missing, stale, or failing evidence and warns when external proof is still missing, such as an attached MTP device, signing certificate, or hosted update feed.
- `npm run verify:perf-100k` runs the dedicated 100k-file stress gate with cold/warm list, warm-list cache-hit/scanned-row, pane-filter, search, folder-index, active-index scanned-row, and background-index budgets.
- `npm run verify:windows-baseline` compares generated 1k/10k/100k folders against Windows-native `.NET DirectoryInfo.EnumerateFileSystemInfos`, proving full warm app listings reuse cache with zero scanned rows, windowed warm listings return only the first viewport slice, and active-index search scans only the narrowed candidate set while native enumeration scans the full folder.
- `npm run verify:large-folder-ui` and `npm run verify:large-folder-100k-ui` prove browser panes paint a bounded first listing window before hydrating the full folder, then switch to virtualized rows for the complete 10k/100k entry set.
- `npm run verify:server-listing-cache` proves duplicate cold folder requests coalesce into one in-flight disk scan, unchanged folder revisits and rich thumbnail/link metadata revisits are served from the server listing cache with zero scanned rows, then writes a new file and verifies the watcher invalidates and re-warms both cache variants.
- `npm run verify:folder-index-token-search` builds a 20k-file active folder index, proves exact token search scans only the narrowed candidate set, and verifies repeat searches hit the warm index cache.
- `npm run verify:mixed-load` runs concurrent foreground folder lists, name searches, content searches, raw file reads, and roots calls against one fixture, then fails if correctness or p95/max latency budgets regress.
- `npm run verify:operations` proves copy/move/sync previews report rename, overwrite, mirror-delete, and unsafe-path cases without mutating files, reject stale preview digests when disk changes before Apply, and accept fresh preview digests.
- `npm run verify:operation-preview-scale` builds large transfer and sync conflict fixtures, proves exact copy/rename/overwrite/skip/mirror-delete/missing-source/risky counts, checks preview latency budgets, and proves preview calls do not mutate disk.
- `npm run verify:power-tools-ui` drives Flat, Dupes, Compare, and sync preview through the browser UI, checks dialog layout, and proves preview does not apply changes.
- `npm run verify:operation-journal` runs real copy, move, permanent delete, app trash, rename, sync, create-file, undo, and retry-remaining operations, then proves persisted Ops rows include progress, results, undo metadata, retry lineage, bounded history, and exact API/disk consistency.
- `npm run verify:operation-journal-concurrency` fires a burst of simultaneous create-file operations and proves every completed operation row survives in API state and persisted `state.json` with disk files and invalidation metadata intact.
- `npm run verify:operation-journal-scale` seeds an oversized Ops history, proves startup trims it to the bounded journal, recovers interrupted rows, then adds a fresh operation while keeping API and `state.json` consistent.
- `npm run verify:operation-journal-retention` seeds an oversized Ops history with an old recoverable failure outside the newest-row window, proves the actionable row survives trimming, retries it, and keeps API/state.json bounded.
- `npm run verify:operation-cancel` cancels a live copy after checkpointed progress, proves the canceled row records only unfinished remaining work, retries that remaining work, and verifies the target folder has no duplicate copies.
- `npm run verify:operation-sync-cancel` cancels a live sync after checkpointed progress, proves the canceled row records only unfinished sync items, retries that remaining work, and verifies the right pane has the exact synced contents.
- `npm run verify:operation-pause-resume` pauses a live copy after checkpointed progress, proves the target folder does not advance while paused, resumes the operation, and verifies the final target set plus persisted operation history.
- `npm run verify:ops-recovery-ui` opens the browser UI with interrupted copy/transfer/sync rows, verifies visible Ops recovery details and retry controls, clicks selection controls and Retry Selected, then checks layout and copied results.
- `npm run verify:state-lock` locks `state.json` like Windows, OneDrive, or antivirus software can, writes settings through the public API, and proves retry, persisted JSON readability, API/disk consistency, and temp-file cleanup.
- `npm run verify:state-corruption` corrupts isolated `state.json` files, proves backup restore and no-backup fallback, verifies corrupt state is not preserved as a backup, and checks later saves heal the backup.
- `npm run verify:crash-recovery` proves stale queued/running/paused operations reopen as failed, interrupted, retryable `Ops` rows after an app restart.
- `npm run verify:crash-kill` kills the backend during checkpointed copy, move, permanent delete, app trash, sync, and rename operations, also kills during an atomic state save, then proves `Ops` and settings recovery stay sane.
- `npm run verify:desktop-backend-recovery` starts the Electron shell, simulates an embedded backend listener failure, and proves the desktop bridge restarts the backend, reloads the renderer, and shows rows again.
- `npm run verify:elevation` proves failed-operation elevated retry planning can prepare an audited helper package without launching UAC or mutating fixture files.
- `npm run verify:elevation-ui` opens failed copy/delete rows in `Ops`, verifies the visible elevation controls, rewrites the smoke request to avoid launching UAC, and proves the prepared helper is shown back in operation details.
- `npm run verify:no-admin-access` proves normal-user browsing redirects Windows legacy known-folder junctions without requiring the app to run as administrator, and that the Size Analyzer follows the same redirect.
- `npm run verify:path-diagnostics` proves local folders, files, missing paths, and parse-only UNC paths return bounded Path Health diagnostics without requiring a real network share.
- `npm run verify:real-paths` discovers actual workspace, OneDrive/cloud, known-folder, drive, and explicit `EB_REAL_PATHS` targets, then runs bounded diagnostics, cold/warm listing, folder-index search, and shallow background-index search.
- `npm run verify:network-loopback` builds a bounded local fixture, reaches it through a loopback UNC path using an existing administrative share or temporary SMB share when Windows allows it, then proves network diagnostics, cold/warm listing, and folder-index search work over UNC.
- `npm run verify:listing-cache-ui` opens the browser UI, proves cold pane source is `Filesystem`, double-clicks into a folder, returns through the path bar, and verifies the warm revisit uses `Memory cache` with unclipped Speed metrics.
- `npm run verify:listing-cache-eviction-ui` churns through more folders than the frontend listing cache can hold, proves old folders are pruned, and verifies the most recent folder still reopens from `Memory cache` without another `/api/list` request.
- `npm run verify:listing-prefetch-ui` hovers many folder rows, proves predictive prefetch stays inside the active request budget, then opens a warmed folder from `Memory cache` without another `/api/list` request.
- `npm run verify:rapid-navigation-ui` opens the browser UI, delays an old folder response, proves stale load abort is attempted, and verifies the final folder still owns the pane with Quick Search responsive afterward.
- `npm run verify:filesystem-objects` proves Windows shortcuts, NTFS hard links, junctions, symlink privilege handling, warm link metadata indexing, background link search, and undo of created filesystem objects.
- `npm run verify:thumbnail-cache-ui` opens the browser UI in tile mode, proves virtualized image tiles load a bounded thumbnail set before/after scroll, and checks versioned raw thumbnail cache headers, conditional `304` behavior, byte-range `206` streaming, invalid-range guards, and repeated conditional requests.
- `npm run verify:cache-maintenance` proves cache maintenance is dry-run by default, removes stale/orphaned/corrupt Explore Better cache files only under app cache roots, and preserves active background roots plus current warm caches.
- `npm run verify:scripting-api` proves trusted scripts can read active/other pane context, selected files, helper APIs, progress/events, operation audit rows, and saved toolbar script execution through the browser.
- `npm run verify:scripting-mutation-cache` proves trusted script helper mutations invalidate warmed listing caches, rewarm cleanly, queue watcher-disabled background-index rebuilds, and search newly written script output.
- `npm run build:icon` regenerates the branded Windows PNG/ICO assets used by the packaged desktop app.
- `npm run verify:release-readiness` proves the package config, branded icon configuration, installer-target configuration, generated Explorer integration kit, Shell Backup restore file, native shell-target readiness, and Electron desktop bridge are coherent, while calling out production warnings for signing and update gaps.
- `npm run verify:release-integrity` hashes the current setup installer, blockmap, unpacked executable, app archive, branded icon input, and packaged source inputs, and fails if those release artifacts are missing, empty, stale, or missing SHA-256 entries.
- `npm run verify:code-signing` signs a copied setup installer with a temporary CurrentUser code-signing certificate, verifies signer metadata, preserves the original installer, and removes the temporary certificate.
- `npm run verify:production-signing` inspects the actual installer and unpacked executable with Windows Authenticode and verifies the expected production certificate when one is configured.
- `npm run verify:production-readiness` writes a final local-vs-external release checklist and fails only on local release evidence gaps unless `-- --strict` is used.
- `npm run build:update-feed` and `npm run verify:release-update-feed` generate and verify `dist\update-feed\latest.yml` plus static installer/blockmap assets for a generic update host.
- `npm run verify:release-update-feed-desktop` serves the generated static feed locally and proves the desktop updater consumes it as the current release.
- `npm run verify:release-bundle` writes a consolidated publishable bundle manifest and cross-checks the installer, blockmap, update feed, desktop updater smoke, signing rehearsal, shell install/revert proof, and release readiness evidence.
- `npm run verify:hosted-update-feed` probes a configured hosted generic update feed and verifies its `latest.yml` and hosted assets match the local release bundle.
- `npm run verify:external-proof` refreshes release prerequisites, then summarizes attached-device, production-signing, and hosted-feed proof; `-- --strict` makes missing external production assets fail.
- `npm run verify:auto-update-feed` starts a local generic update feed and proves the desktop updater bridge can check a configured feed and report an available version without downloading it.
- `npm run verify:shell-rehearsal` installs and removes the app copy, Start Menu/Desktop shortcuts, optional Win+E startup helper, and generated shell-handler files under isolated temporary profile paths without importing HKCU registry files.
- `npm run verify:shell-current-user` imports the generated shell-handler registry files into the real current-user HKCU shell keys, verifies the context menu and default folder handler are enabled, proves the installed desktop handler opens a target folder, then restores and compares the pre-trial registry state.
- `npm run verify:shell-verbs` proves native Windows shell verbs can be enumerated for a fixture file and dry-run selected without launching or mutating anything.
- `npm run verify:shell-namespace` proves This PC enumerates through Windows Shell.Application, checks Network and Libraries return bounded structured reports, validates Network warm-cache speed, validates pane-openable shell items, and dry-runs shell handoff.
- `npm run verify:shell-devices` proves phone/MTP/camera-style shell providers under This PC are treated as shell-only devices, not normal pane folders, records This PC warm-cache evidence, captures a Windows PnP/CIM hardware snapshot without elevation, and browses or dry-runs a device target when one is attached. Use `npm run verify:shell-devices -- --require-device` to make attached-device proof a hard gate, and add `--device-query="DEVICE NAME"` when targeting a specific phone or camera.
- `npm run verify:native-shell-readiness` writes a final local-vs-attached-device native-shell checklist and fails only on local shell evidence gaps unless `-- --strict` is used.
- `npm run verify:shell` proves the Navigator Shell API exposes This PC, Libraries, Network, Recycle Bin, special folders, and discovered Windows Library targets while rejecting unknown shell-open IDs.
- `npm run verify:windows-recycle` creates one temp file, recycles it, lists it through the in-app Windows Recycle API, dry-runs restore validation, restores it through `Ops`, and confirms it returns to disk.
- `npm run verify:zip-browse` creates a nested ZIP fixture, browses it through the virtual pane API without extracting, and checks parent paths and timing output.
- `npm run verify:background-index` proves recursive background indexes and warm-cache filename, label-note, and text-content searches.
- `npm run verify:background-index-freshness` proves external folder changes mark a warm background cache stale, auto-start a rebuild, clear the stale signal, and find the new file.
- `npm run verify:background-index-watch` proves bounded indexed-folder watchers observe disk changes, debounce create/delete/rename bursts into one repair, remove stale deleted and renamed hits, resume after backend restart, clear the stale signal, and find the current files.
- `npm run verify:background-index-restart` proves a warm background index survives backend restart and still serves filename, label-note, and text-content searches from the persisted store.
- `npm run verify:background-index-isolation` starts a content-heavy background index and proves foreground list/search requests for another folder stay within latency budgets while indexing is still running.
- `npm run verify:background-index-concurrency` builds a large background index, restarts the backend, fires a concurrent first-search herd, proves duplicate persisted-store reads join one in-flight load, then verifies the warm cache takes over.
- `npm run verify:background-priority` proves foreground folder scans keep the high-concurrency lane while background indexes use the lower-priority worker lane and still serve warm content hits.
- `npm run verify:background-index-cancel` starts a loaded recursive content index, stops it while running, proves no partial complete cache is exposed, then restarts and searches the rebuilt warm cache.
- `npm run verify:speed-index-ui` drives the visible Speed panel in the browser, builds the active folder index, searches saved label metadata, adds a background root, shows watcher coverage, searches nested text content from the warm background cache, proves stale-cache auto-rebuild recovery, and checks Speed dialog layout.
- `npm run verify:search-background-ui` drives the normal Search dialog in the browser, uses `Warm Cache`, proves scoped indexed content and label-note results, and checks Search dialog layout.
- Foreground folder scans use `EXPLORE_BETTER_LIST_CONCURRENCY`; background folder scans use `EXPLORE_BETTER_BACKGROUND_LIST_CONCURRENCY`; background text-content indexing uses `EXPLORE_BETTER_CONTENT_INDEX_CONCURRENCY`.
- `npm run verify:interaction-resize` drags the navigator, pane splitter, preview, command dock, and horizontal pane-row handles in a browser, proves geometry changes persist through `/api/state` and reload, and checks double-click folder open after resizing.
- `npm run verify:layout` opens the app in browser viewports with crowded long-name favorites and fails if header/root-strip, toolbar, or dock controls are unreachable, outside their containers, clipped, or squished.
- `npm run verify:pane-layout-no-scrollbars` opens crowded dual-pane browser layouts and fails if the path bar, breadcrumbs, toolbar, or details header become scrollable or spill outside their pane chrome.
- `npm run verify:size-analysis-ui` drives the Analyzer through the browser UI, verifies the visible Cancel button restores controls from an active scan, checks folder/file/extension totals plus allocated-size/category fields, verifies file-type swatches, hovers and clicks a treemap block to select the real file, and audits the Analyzer for clipped controls or unwanted inner scrollbars.
- `npm run verify:size-analysis-perf` builds a 10k-file Analyzer fixture, fires a concurrent cold Analyzer herd to prove duplicate requests coalesce into one filesystem walk, proves foreground list, active-index search, and roots requests stay responsive while an uncached Analyzer scan is running, proves repeat scans return from the Analyzer cache, then creates a file through the app API and proves the cache is invalidated and re-warmed.
- `npm run verify:size-analysis-cancel` starts duplicate Analyzer scans, aborts the origin request, proves the active duplicate restarts instead of inheriting the abort, keeps foreground list/roots requests responsive after cancellation, and verifies the recovered scan warms the Analyzer cache.
- `npm run verify:large-folder-ui` opens a 10k-entry browser fixture, proves virtualized row rendering stays bounded, checks stressed header layout, and verifies filtering plus virtual scrolling.
- `npm run verify:large-folder-100k-ui` opens a 100k-entry browser fixture on desktop, proves virtualized row rendering stays bounded, and verifies the client filter path still responds.
- `npm run verify:keyboard-workflows-ui` drives command-palette execution and Quick Search filtering entirely from the keyboard, checks focus handoff, and verifies the keyboard UI is not clipped or squished.
- `npm run verify:accessibility` checks useful accessible names, keyboard file-list navigation, command-palette focus, and high-contrast focus styling.

If a folder looks stale, press `R` or click Refresh.

## Recovery And Safety

`Trash Bin` has two modes. App Trash keeps app-managed trash under `%LOCALAPPDATA%\ExploreBetter\Trash`, restores selected items into the active pane, and supports permanent deletion after confirmation. Windows Recycle lists current-user Recycle Bin items in-app and can restore selected items through Windows back to their original locations with an `Ops` history row. Permanent Delete cannot be restored by Explore Better.

Most app-managed file operations are recorded in `Ops`; use operation details and undo where available.

Failed copy, move, and permanent-delete operations can expose elevated recovery actions when remaining retry metadata exists. Elevated helpers are written under `%LOCALAPPDATA%\ExploreBetter\Elevation`, include a manifest hash for the structured payload, and only run through Windows UAC after an explicit elevated action in `Ops`. Preparing or dry-running a helper does not change files.

If Explore Better or Windows restarts during a copy, move, delete, trash, recycle, transfer, or sync operation, reopen `Ops`. Interrupted queued/running/paused work is marked failed with restart details and remaining-work retry controls when enough metadata was saved. Restart-derived completion lists are marked unverified, so inspect the source and destination before retrying anything destructive.

## Troubleshooting

- If a button seems inactive, check whether a modal dialog is open.
- If a shell integration target does not open, use `Integrate` and run preflight/status checks.
- If a folder does not update after external changes, enable `Auto` or press Refresh.
- If the interface feels cramped, drag the layout separators or use `Prefs` to switch density.
- If a command dock is too crowded, use `Toolbar` to choose a smaller visible command set, or drag the dock taller.
