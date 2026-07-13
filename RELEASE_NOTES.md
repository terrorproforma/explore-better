# Explore Better Release Notes

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
