# Explore Better Release Notes

## v0.2.4 - 2026-07-17

### Product-Tested Navigation And Device Experience

- Kept the Electron title bar to one measured 44 px row from 390 through 1920 px, with deterministic label collapse and keyboard-accessible overflow for Focus, Operations, and Disk Map.
- Combined Favorites and Aliases into a compact Pinned presentation without changing either saved model, moved Folder Tree above Drives, limited Recent to eight initial entries, and retained one Navigator scroll owner.
- Replaced the ambiguous This PC shell browser with a capability-aware Devices & Windows locations dashboard. Default loading never waits on the Network provider, and every action says whether it stays in Explore Better or requests File Explorer.
- Added command outcome chips and plain-language expected results for in-app, File Explorer, external-app, and Windows-dialog actions.

### MCP Control And Observability

- Expanded the additive schema-v1 contract to 32 tools, 6 resources, 4 prompts, and 43 controlled views while preserving existing profile permission lists.
- Added a renderer-owned, selector-free semantic action registry with validated inputs, disabled reasons, stale-context rejection, correlation IDs, and visible outcomes.
- Added cancelable event-driven `wait_for_ui`, proper bridge request cancellation, and standard context/operation resource subscriptions that publish only the changed URI.
- Added Devices and Health views/resources, updated the Go sidecar and internal bridge protocol atomically, and added native-sidecar tests for semantic boundaries, operation waits, subscriptions, and cancellation.

### Recovery, Diagnostics, Preferences, And Performance

- Added bounded operation timelines with phase/progress deduplication, retry/Undo linkage, recovery events, and synthesized display timelines for older journal rows.
- Added Health & diagnostics with bounded active probes, scheduler metrics, and a streamed 10 MB support ZIP that redacts paths by default and permanently excludes file contents, terminal output, clipboard data, credentials, nonces, and capability/apply tokens.
- Added sticky Preferences search, no-results feedback, per-section draft-change badges, and draft-only scoped reset actions for Files and folders, Windows integration, and Terminal.
- Added shared foreground scheduling so speculative listing and background index work pause for navigation, search, analysis, active operations, or hidden windows and resume without duplicating cached requests.

### Website And Verification

- Repositioned the website around safe shared control: Explore Better is a Windows file manager that both people and AI can operate without screen scraping or unrestricted shell access.
- Added current Devices, Health, semantic-action, operation-timeline, and foreground-scheduling value propositions plus refreshed release screenshots and measured performance evidence.
- Preserved the previous 17 July 2026 homepage as a no-index legacy snapshot alongside the earlier 15 July archive.
- Passed the complete 130-suite acceptance profile with zero internal failures, 175/175 speed-health checks, 31/31 release-readiness checks, and only the documented external hardware, trusted-certificate, and hosted-feed proofs outstanding.

## v0.2.3 - 2026-07-16

### Complete Brand Replacement

- Replaced the previous geometric monogram with the supplied Racing Sans One `EB` artwork as the single canonical brand source.
- Regenerated the website and in-app SVG, every PNG density, favicon, Windows multi-image ICO, executable and installer resources, AI Bridge tray icon, and standalone MCPB icon from that source.
- Added explicit branded window and tray assets for both packaged and development runs, and made generated Desktop, Start Menu, shell, and Win+E shortcuts prefer the same ICO.
- Wired brand generation into every packaging, site-discovery, and MCPB build so later installers cannot silently fall back to stale artwork.
- Re-recorded the real product walkthrough and Codex handoff, retimed the edit to the new capture, rebuilt the website video and poster, and recaptured every public product screenshot with the new in-app mark.
- Updated the deprecated homepage's active favicon and header/footer references while preserving its archived copy and layout.

### Verification

- Added an exhaustive brand-asset smoke covering the canonical SVG copies, seven PNG sizes, embedded ICO images, runtime window/tray wiring, shortcut generation, site references, packaging scripts, and demo composition.
- Visually inspected the generated 256 px icon, live app screenshots, video opening, Codex handoff, and final CTA.

## v0.2.2 - 2026-07-16

### In-App Updates

- Added a quiet update check shortly after desktop launch and every six hours while Explore Better remains open.
- Added a branded, dismissible update card with the available version, release notes, background download progress, and an explicit **Restart to update** action.
- Kept downloads user-controlled and allowed verified downloads to install on either the explicit restart action or the next normal app exit.
- Added a **Check for updates** Command Palette action and a Windows notification when a new version is detected while the app is minimized.
- Restricted update status, download, and install requests to the trusted Explore Better renderer.
- Documented the one-time bootstrap upgrade required for builds that predate the in-app updater experience.

### Verification

- Extended the desktop update-feed smoke through real release detection, installer download and hash verification, visible notification state, and restart-ready state.
- Verified the public release feed, desktop bridge, responsive layouts, Command Palette, and accessibility with no failures.

## v0.2.1 - 2026-07-15

### Brand System

- Replaced the detailed legacy app illustration with a geometric `EB` dual-pane monogram matched to the website's ink, paper, acid, and teal palette.
- Added one deterministic brand generator for the SVG master, website and application PNGs, Windows executable and installer ICO sizes, favicons, README, and MCPB icon.

### AI Discovery And MCP Evidence

- Added a dedicated crawlable MCP technical page with the complete value case, tool categories, security model, setup path, deliberate limitations, and links to raw evidence.
- Added canonical URLs, Open Graph and social metadata, honest `SoftwareApplication` JSON-LD, `robots.txt`, `sitemap.xml`, `llms.txt`, and a detailed `llms-full.txt` reference.
- Explicitly allowed OAI-SearchBot while keeping the public site available to ordinary crawlers and anonymous users.
- Added a reproducible benchmark that runs the real Electron host and Go stdio sidecar against the same deterministic fixture as equivalent PowerShell scripts.
- Proved 3 of 3 shared workflows and 6 of 6 MCP-specific controls, while documenting that MCP complements rather than replaces a persistent shell.
- Added automated crawler, structured-data, benchmark-sync, responsive-layout, and AI-discovery verification to Windows CI.
- Canonicalized authorized, client, and internal roots before policy comparison so Windows path aliases remain usable without weakening junction-escape protection.
- Strengthened pagination evidence to verify two bounded, non-overlapping pages and stabilized the warm bridge p95 gate with explicit warm-up and 100 measured calls.
- Repositioned the website around the human-and-AI file workspace, with focused category, MCP, client integration, security, privacy, terms, and practical workflow pages.
- Published the measured comparison ratios transparently: 54.7x lower median filename-search latency, 6.2x disk-analysis latency, and 4.5x duplicate-search latency versus equivalent fresh PowerShell processes on the deterministic fixture.
- Added a standalone Windows MCPB distribution, MIT license, SHA-256 metadata, installed-app discovery, and an official MCP Registry publishing workflow for `io.github.terrorproforma/explore-better`.
- Added reversible Cursor configuration alongside Codex, Claude Desktop, and VS Code.

## v0.2.0 - 2026-07-14

Explore Better now connects serious file work to both a real shell and structured AI tools. This release adds the local MCP AI Bridge and ships it alongside the per-tab ConPTY terminals introduced in v0.1.3.

### AI Bridge And MCP

- Added a bundled Go `ExploreBetterMcp.exe` stdio server using the official MCP SDK and protocol `2025-11-25`.
- Added live dual-pane context, bounded discovery, Analyzer and comparison jobs, organization tools, and transactional operation control.
- Added read-first revocable profiles with authorized roots, individual tool permissions, client-root intersection, and a 30-day content-free audit log.
- Added one-use preview/apply tokens for all MCP writes and blocked shell execution, terminal control, registry access, elevation, device paths, alternate data streams, and internal app state.
- Added authenticated same-user named-pipe transport, headless AI-host lifecycle, tray status, heartbeat, reconnect, cancellation, and stable renderer actions.
- Added reversible setup adapters for Codex/ChatGPT desktop, Claude Desktop, and VS Code plus a generic stdio configuration.
- Added contract, security, context, analysis, operation, client, performance, and packaged-sidecar verification suites.

### Terminal And AI Workspace

- Made the per-tab terminal and AI Bridge first-class product modules with real desktop release captures and dedicated landing-page sections.
- Kept arbitrary commands in the terminal while exposing bounded, typed file context, discovery, analysis, and recoverable operations through MCP.
- Scoped MCP discovery to each client's permitted tools so read-only profiles cannot discover or invoke write planners or apply controls.
- Added a repeatable packaged-app capture check that proves the terminal is interactive and the AI Bridge profile contract is loaded before release imagery is produced.

### Verification

- Passed the complete 42-check release orchestrator with no failures.
- Verified the MCP server through the official MCP Inspector with exactly 17 tools exposed to the release read-only profile.
- Measured 5.3 ms MCP bridge p95, 14.1 MB sidecar RSS, 403.3 ms first visible window, 1.22 s full hydration, and 45 rendered rows in the 100,000-entry fixture.
- Verified zero production or development audit vulnerabilities.

## v0.1.3 - 2026-07-13

### Per-Tab Integrated Terminals

- Added a real interactive terminal to every file tab in the Electron desktop app.
- Added independently resizable terminal drawers beneath the left and right panes.
- Added lazy xterm.js rendering and Windows ConPTY sessions through node-pty.
- Added PowerShell 7, Windows PowerShell, and Command Prompt profile discovery.
- Added idle-only folder following, queued navigation, current-directory reporting, and explicit pane navigation from the terminal folder.
- Added terminal search, clear, restart, external launch, drag-and-drop path quoting, and keyboard controls.
- Added Dark, Light, and High Contrast themes with configurable font size, cursor, and scrollback.
- Added optional administrator terminals through a one-session UAC broker while keeping the main application non-elevated.
- Added terminal lifecycle cleanup for tab close, window close, renderer failure, and app exit.
- Added real ConPTY, hostile IPC, per-tab UI, layout, and cleanup verification.

### Stability

- Fixed an Electron close-handler crash caused by reading a destroyed `BrowserWindow` while cleaning up terminal sessions.
