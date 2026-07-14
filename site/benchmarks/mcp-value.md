# Explore Better MCP Value Benchmark

Generated: 2026-07-14T11:24:55.905Z

This benchmark compares the real Explore Better Electron host and Go MCP stdio sidecar with equivalent PowerShell scripts on the same deterministic Windows fixture. It validates correctness first. Timings are reported for transparency, not as a claim that MCP is always faster than a warm shell.

Result: **3/3 shared workflows correct in both interfaces**, plus **6/6 MCP-specific controls proven**.

| Workflow | MCP | PowerShell | MCP median | PowerShell median |
| --- | --- | --- | ---: | ---: |
| Find matching reports | pass | pass | 9.8 ms | 536.1 ms |
| Find content duplicates | pass | pass | 130.4 ms | 580.5 ms |
| Measure disk usage | pass | pass | 72.3 ms | 445.4 ms |

## What MCP Proved

- **PASS - Model-discoverable typed contract:** 17 profile-permitted tools exposed with JSON input schemas; destructive tools are absent from discovery.
- **PASS - Bounded pagination:** A 360-entry folder returned exactly 25 entries and an opaque continuation cursor.
- **PASS - Live file-manager context:** The AI read live tab context, opened a folder in a new left-pane tab, then observed the revised pane state.
- **PASS - Authorized-root enforcement:** A read outside the profile root was rejected with OUTSIDE_ROOTS. A normal shell retains the user's broader filesystem authority.
- **PASS - Read-only capability reduction:** plan_delete, plan_transfer, plan_text_write, and apply_operation were not exposed to the read-only profile.
- **PASS - File-manager-specific allocation semantics:** Analyzer returned labeled exact allocation data; the generic PowerShell baseline reported logical bytes only.

## Interpretation

PowerShell remains better for arbitrary commands and one-off system administration. Explore Better MCP is valuable when an AI needs the file manager's live pane context, bounded typed results, indexed/analyzer semantics, folder-scoped authorization, or plan/apply operations that use the app's transaction journal. It complements the terminal rather than replacing it.

## Reproduce

```powershell
npm run verify:mcp-value
```

The machine-readable report is published at [mcp-value.json](./mcp-value.json).
