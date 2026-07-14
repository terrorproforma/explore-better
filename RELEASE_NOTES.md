# Explore Better Release Notes

## v0.1.3 - 2026-07-13

### AI Bridge And MCP

- Added a bundled Go `ExploreBetterMcp.exe` stdio server using the official MCP SDK and protocol `2025-11-25`.
- Added live dual-pane context, bounded discovery, Analyzer and comparison jobs, organization tools, and transactional operation control.
- Added read-first revocable profiles with authorized roots, individual tool permissions, client-root intersection, and a 30-day content-free audit log.
- Added one-use preview/apply tokens for all MCP writes and blocked shell execution, terminal control, registry access, elevation, device paths, alternate data streams, and internal app state.
- Added authenticated same-user named-pipe transport, headless AI-host lifecycle, tray status, heartbeat, reconnect, cancellation, and stable renderer actions.
- Added reversible setup adapters for Codex/ChatGPT desktop, Claude Desktop, and VS Code plus a generic stdio configuration.
- Added contract, security, context, analysis, operation, client, performance, and packaged-sidecar verification suites.

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
