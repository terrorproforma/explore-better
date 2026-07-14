# Explore Better Release Notes

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
