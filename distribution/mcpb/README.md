# Explore Better MCP Bridge

Explore Better is a Windows file manager built for people and AI to work from the same visible folders. This MCPB connects a compatible local AI client to the installed Explore Better desktop app through a folder-scoped, revocable profile.

## Features

- Live pane, tab, folder, focus, and selection context.
- Bounded directory listing, indexed search, metadata inspection, and text reads.
- Disk usage analysis, duplicate discovery, checksums, and folder comparison.
- Preview-first collection, label, transfer, rename, delete, archive, create, and text-write operations.
- Durable operation status, cancellation, recovery, and undo through Explore Better.
- Local stdio transport and an authenticated same-user named pipe. No arbitrary shell or terminal control.

## Requirements

- Windows 11 x64.
- Explore Better 0.2.0 or later installed from the [official GitHub release](https://github.com/terrorproforma/explore-better/releases/latest).
- A compatible desktop client with MCPB or local stdio support.

## Installation

1. Open Explore Better and go to **Preferences > AI Bridge**.
2. Enable the bridge and create a read-only profile for this client.
3. Add only the folders and tools the client needs, then save the profile.
4. Copy the generic configuration snippet and note the value after `--profile`.
5. Install this MCPB in the client and enter that value as the **Explore Better profile ID**.
6. Leave the application path blank for a normal per-user installation.

The bridge can start an installed Explore Better headless host when the visible app is closed. Opening a UI action creates the normal desktop window.

## Examples

### Investigate the visible selection

Prompt: `Summarize the files I selected in Explore Better and identify anything unusually large.`

Expected behavior: the client reads live selection context, inspects bounded metadata, and reports findings without modifying files.

### Find safe disk-space savings

Prompt: `Analyze this folder for large files and duplicates. Quantify savings but do not delete anything.`

Expected behavior: the client starts cancellable disk and duplicate jobs, returns bounded results, and leaves the filesystem unchanged.

### Organize a folder with approval

Prompt: `Plan a reversible cleanup of this Downloads folder. Show me the proposed moves and stop before applying them.`

Expected behavior: the client creates a current preview only. Any later apply requires the same profile, a one-use token, unchanged filesystem signatures, and the profile's write permission.

### Compare two folders

Prompt: `Compare the left and right folders, explain meaningful differences, and prepare but do not apply a sync plan.`

Expected behavior: the client uses the visible pane paths, returns a bounded comparison, and stops at the preview boundary.

## Security Model

- The AI Bridge is disabled until the user enables it.
- Every client uses a separately revocable profile.
- Effective access is limited by profile roots, client roots when supplied, and Windows permissions.
- Filenames and file contents are treated as untrusted data.
- Write-capable profiles must plan first and consume a short-lived one-use apply token.
- Protected paths return an elevation error; this MCPB never controls UAC or administrator terminals.

## Privacy Policy

Explore Better has no hosted file-processing service and does not intentionally transmit filenames or file contents to an Explore Better server. Data returned through MCP is delivered to the AI client the user configured and is then subject to that client's policies. See the complete [Explore Better privacy policy](https://terrorproforma.github.io/explore-better/privacy/).

## Support

Use [GitHub Issues](https://github.com/terrorproforma/explore-better/issues) for bugs and support. Include the Explore Better version, client name, and redacted error code. Do not attach private filenames, file contents, profile IDs, pipe names, nonces, or capability tokens.
