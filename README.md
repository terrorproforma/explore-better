# Explore Better

[![Latest release](https://img.shields.io/github/v/release/terrorproforma/explore-better)](https://github.com/terrorproforma/explore-better/releases/latest)
[![Windows CI](https://github.com/terrorproforma/explore-better/actions/workflows/windows-ci.yml/badge.svg)](https://github.com/terrorproforma/explore-better/actions/workflows/windows-ci.yml)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4)

**A fast, dual-pane Windows file manager with tabs, scripting, transactional file operations, reversible Explorer integration, and a visual disk-space analyzer.**

[Download the latest Windows release](https://github.com/terrorproforma/explore-better/releases/latest) | [Read the user manual](USER_MANUAL.md) | [Report an issue](https://github.com/terrorproforma/explore-better/issues)

## Why Explore Better Exists

Windows Explorer is familiar, but demanding file work quickly outgrows it. Large folders can feel slow, multi-folder work needs too many windows, destructive operations provide limited recovery context, and advanced jobs such as disk analysis, synchronization, duplicate finding, indexing, and automation usually require separate applications.

Explore Better was built to provide one focused Windows workspace that:

- stays responsive in very large folders;
- makes source and destination panes visible at the same time;
- treats copy, move, overwrite, sync, and delete work as inspectable operations;
- combines everyday browsing with disk analysis, search, indexing, previews, and automation;
- runs as the current user for normal browsing instead of requiring administrator rights;
- can integrate with Explorer when wanted, while keeping that integration optional and reversible.

The aim is the depth of a serious Explorer replacement without giving up speed, understandable controls, or recovery when a file operation is interrupted.

## Install On Windows

### Requirements

- Windows 10 or Windows 11, x64
- A normal Windows user account
- Administrator approval only when Windows itself requires access to a protected location

### Recommended Installation

1. Open the [latest release](https://github.com/terrorproforma/explore-better/releases/latest).
2. Download `ExploreBetter-<version>-x64-setup.exe`.
3. Download `SHA256SUMS.txt` from the same release.
4. Verify the installer checksum in PowerShell:

```powershell
Get-FileHash .\ExploreBetter-*-x64-setup.exe -Algorithm SHA256
```

5. Compare the result with the installer entry in `SHA256SUMS.txt`.
6. Run the installer and choose the installation folder and shortcuts you want.

The installer is per-user by default. Normal browsing, the native filesystem helper, Disk Map, indexing, previews, and file operations do not require the main application to run as administrator.

### Windows SmartScreen Notice

The current public preview is not Authenticode-signed because a trusted production certificate is not yet available. Windows SmartScreen may show an unrecognized-app warning. Verify the published SHA-256 checksum before choosing **More info** and **Run anyway**.

### Explorer Integration

Explorer replacement features are disabled by default. The in-app **Integration Center** can install current-user shortcuts and shell handlers, show their status, back up the values it changes, and remove the integration again. Explore Better can be used as a standalone file manager without changing Explorer.

## Feature Modules

### Dual-Pane File Browser

- Independent left and right panes with tabs, tab history, locked tabs, and reopen/cycle shortcuts.
- Details, compact, and tile views with configurable columns and image thumbnails.
- Editable path bars, clickable breadcrumbs, aliases, recent paths, and folder suggestions.
- Text, kind, and label filters plus Explorer-style keyboard selection and find-as-you-type.
- Vertical, horizontal, and single-pane layouts with resizable Navigator, pane splitters, Preview, columns, and command dock.
- Linked Panes, Auto Refresh, hidden/system item controls, and reusable folder formats.

### High-Performance Large Folders

- Progressive first paint instead of waiting for an entire directory to hydrate.
- Virtualized file lists that keep only a small visible row window in the DOM.
- Shared listing work for matching panes, cached metadata, bounded prefetching, and background hydration.
- Native Win32 enumeration for local folders with a Node fallback for unsupported paths and platforms.
- Persistent Speed Index and Background Index options for repeated searches.

The current 100,000-entry acceptance fixture records a 403.3 ms median first visible window, 1,097.9 ms median full hydration, and 45 rendered rows.

### Transactional File Operations

- Copy, move, rename, bulk rename, transfer, sync, archive, recycle, app trash, and permanent delete.
- Conflict previews with rename, overwrite, and skip policies before files are changed.
- Destination-volume staging and overwrite backups for recoverable commits.
- Operation queue with progress, transfer rate, ETA, pause, resume, cancel, retry, and undo metadata.
- Startup reconciliation for interrupted operations and cross-volume moves awaiting source removal.
- Protection against drive-root deletion, app-state deletion, recursive source/destination mistakes, and stale destructive previews.

### Disk Map And Size Analyzer

- Full-window hierarchical treemap for understanding where disk space is used.
- Nested folder and file rectangles with drill-down, breadcrumbs, Root, Up, Focus, and Open actions.
- Logical-size and allocated-size modes with clearly labelled accuracy information.
- Color by file type or stable top-folder branch.
- Top folders, files, extensions, and type-category summaries.
- Warm scan caching, cancellation, operation invalidation, and keyboard navigation.
- Exact local Windows allocation data through `GetCompressedFileSizeW` and volume geometry.

### Search, Indexing, And Cleanup

- Bounded recursive filename and text-content search.
- Filters for kind, size, timestamps, and Windows attributes.
- Warm-cache search across saved background-index roots.
- Flat View for recursively presenting a folder as one virtual pane.
- Duplicate Finder with same-size grouping and optional SHA-256 confirmation.
- Checksum manifest creation and verification with SHA-256, SHA-1, or MD5.
- Folder-size calculation directly inside normal file panes.

### Compare And Synchronize

- Left/right folder comparison with left-only, right-only, newer, different, and type-mismatch states.
- Top-level or recursive comparison.
- Explicit left-to-right and right-to-left sync plans.
- Reusable Sync Profiles for folder pairs and policies.
- Optional mirror cleanup through recoverable App Trash moves.
- Preview tokens that reject an apply if the filesystem changed after planning.

### Organization And Workspaces

- Favorites, path aliases, recent folders, and expandable folder trees.
- Named layouts that restore panes, tabs, filters, sorting, view modes, and panel sizes.
- Folder Tab Groups, File Collections, Selection Sets, and Pane Snapshots.
- File Basket for gathering paths from multiple locations before a batch action.
- Color labels and notes that follow app-managed rename, copy, and move operations.
- Folder Formats, Display Presets, and Filter Presets.
- Exportable configuration backups for workspace and automation settings.

### Preview, Viewer, And Quick Edit

- Built-in previews for folders, text, images, PDFs, audio, and video.
- Larger Viewer with neighboring-file navigation and a filmstrip.
- Quick Edit for small text files with an undoable save operation.
- Properties and Path Health views with sizes, timestamps, hashes, drive information, and bounded diagnostics.
- Native Windows Properties and Reveal in Explorer handoff when needed.

### Command Center And Automation

- Searchable command palette with fuzzy matching, pins, history, and hotkey badges.
- Custom command dock profiles for frequently used actions.
- Saved trusted PowerShell or Command Prompt tools with captured output.
- Saved trusted scripts with a bounded file-management API.
- Custom app-level hotkeys for built-in actions, tools, and scripts.
- Open With presets and extension-matched quick launchers.

### Windows Shell And Explorer Replacement

- Navigator access to This PC, drives, libraries, Network, Recycle Bin, and discovered shell locations.
- ZIP browsing as read-only virtual folders without extracting first.
- Windows file clipboard and drag/drop interoperability with Explorer and the desktop.
- Recycle Bin browsing and native restore support.
- Optional current-user context menus, folder handlers, shortcuts, startup behavior, and Win+E helper.
- Integration backup, status reporting, launch tests, rollback, and cleanup from one center.

### Native Windows Filesystem Provider

- Bundled Go x64 helper using a versioned NDJSON protocol.
- Request IDs, progress messages, cancellation, and structured Windows errors.
- Fast directory enumeration, tree scanning, volume information, and allocated-size lookup.
- Supervised helper lifecycle so a helper failure does not crash the desktop app.
- Node fallback for UNC paths, unsupported filesystems, non-Windows development, or helper failure.

### Security And Recovery

- Loopback-only backend with a random per-launch API capability.
- Host, Origin, fetch-metadata, method, and JSON mutation validation before route dispatch.
- Strict Electron navigation and permission boundaries.
- One-use destructive apply tokens bound to normalized paths, policy, and filesystem signatures.
- Durable operation journal, backup records, and deterministic recovery choices.
- Normal-user operation by default, with narrow elevation packages only for protected remaining work.

## First-Run Workflow

1. Launch Explore Better from the Start Menu or desktop shortcut.
2. Open a source folder in one pane and a destination folder in the other.
3. Double-click folders to navigate, or use `Enter`, breadcrumbs, history, and the path bar.
4. Use `F5` to copy or `F6` to move the current selection to the opposite pane.
5. Open **Ops** to inspect progress, retry remaining work, recover an interrupted operation, or undo a supported action.
6. Open **Disk Map** to scan the active folder and drill into its largest branches.
7. Open **Command** or press `Ctrl+P` to find every action without exposing every control in the toolbar.

The [user manual](USER_MANUAL.md) covers all primary controls, keyboard workflows, resizing, file operations, Disk Map, scripting, recovery, and Explorer integration.

## Project Architecture

| Area | Location | Responsibility |
| --- | --- | --- |
| Electron desktop shell | `electron-main.mjs` | Native window, backend supervision, single-instance routing, updater bridge, and external URL policy |
| Renderer bridge | `electron-preload.cjs` | Narrow desktop capabilities exposed to the local UI |
| Local backend | `server.mjs` | Filesystem providers, operations, recovery, indexing, search, Analyzer, shell integration, and API security |
| User interface | `public/` | Dual-pane workspace, dialogs, Disk Map, command system, and virtualized lists |
| Native filesystem helper | `native/fshelper/` | Go Win32 enumeration, allocation data, tree scans, progress, and cancellation |
| Verification fleet | `scripts/` | Security, operations, performance, package, updater, shell, layout, and acceptance checks |

The desktop app starts the backend on a private random loopback port and verifies its identity before loading the renderer. Development mode can also run the interface directly in a browser.

## Build From Source

### Prerequisites

- Node.js 20 or newer
- npm
- Go 1.23 or newer for the native Windows helper
- Windows 10 or Windows 11 for the desktop package and Win32 verification

### Clone And Run The Desktop App

```powershell
git clone https://github.com/terrorproforma/explore-better.git
cd explore-better
npm ci
npm run build:native-helper
npm run desktop
```

### Run The Browser Development Version

```powershell
npm start
```

Then open [http://127.0.0.1:4627](http://127.0.0.1:4627).

### Build Windows Packages

```powershell
npm run build:icon
npm run package:dir
npm run package:win
npm run package:installer
```

Generated packages are written to `dist/`.

## Verification

Run the release-critical checks sequentially:

```powershell
npm run verify:all
```

Run the complete verification fleet:

```powershell
npm run verify:all:full
```

Useful focused checks include:

```powershell
npm run verify:security-boundary
npm run verify:transactional-operations
npm run verify:native-helper
npm run verify:layout
npm run verify:speed-health
npm run verify:release-readiness
```

The consolidated verifier timestamps its evidence under `artifacts/acceptance/`, isolates performance runs, enforces timeouts, and removes test-owned child processes.

## Public Release Status

The current public release provides a per-user Windows x64 installer, native helper, checksum manifest, blockmap, and GitHub-hosted update metadata. Public Windows CI verifies dependency audit, native helper compilation, security boundaries, transactional rollback, helper protocol behavior, layouts, and folder double-click behavior.

Two external certification inputs remain outstanding:

- trusted production Authenticode signing;
- physical MTP/PTP phone or camera certification.

These limitations are disclosed in each release. They do not require normal browsing to run as administrator.

## License

The repository is currently published as `UNLICENSED`. The source is visible for inspection, but no open-source redistribution or modification license has been granted yet.
