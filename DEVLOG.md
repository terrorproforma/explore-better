# Explore Better Devlog

## 2026-07-14 21:25 +10:00 - AI discovery and MCP value proof

- Added a real Electron/Go-sidecar MCP-versus-PowerShell benchmark with deterministic ground truth, three measured repetitions, machine-readable evidence, and an explicit warm-shell limitation.
- Added a crawlable MCP technical page, benchmark JSON/Markdown, canonical and social metadata, `SoftwareApplication` JSON-LD, `robots.txt`, `sitemap.xml`, `llms.txt`, and `llms-full.txt`.
- Added `verify:mcp-value` and `verify:seo-discovery`, wired both into Windows CI, and synchronized the visible benchmark table from the published JSON.
- Updated README, user manual, release notes, GitHub description, homepage, and repository topics for Windows file-manager and MCP discovery.
- Validation: MCP contract, security, context, analysis, operations, performance, and value suites passed; landing page passed 40/40; SEO discovery passed 56/56 at desktop/mobile sizes with OAI-SearchBot endpoint checks.
- Final consolidated validation: `verify:all` passed 44/44, release readiness passed 31/31, speed health passed 175/175, packaged MCP matched the source sidecar, and the goal audit completed with 0 failures.
- Remaining release limitation: the public Windows preview is still unsigned, and official MCP Registry publication needs an independently supported package artifact rather than the current app-bundled sidecar.

## 2026-07-14 22:15 +10:00 - Clean-run MCP root correction

- GitHub's clean Windows runner revealed that a temporary path alias could make a valid child folder fail MCP authorization as `OUTSIDE_ROOTS`; the benchmark's original exact-page assertion obscured the underlying error.
- Canonicalized profile, client, and internal policy roots before comparison, while continuing to canonicalize every candidate path and deny junction escapes.
- Added an authorized junction-root regression test and changed the pagination proof to validate two bounded, cursor-linked, non-overlapping pages.
- Added warm-up and 100 measured calls to the unchanged 20 ms MCP bridge p95 gate; three local repeats passed at 6.6 ms, 3.0 ms, and 5.8 ms.
- Replaced the PowerShell baseline's optional `Get-FileHash` dependency with the built-in .NET SHA-256 API for clean Windows runner compatibility.
- Canonicalized the live-context navigation target before comparing renderer state so equivalent Windows short and long path spellings produce the same evidence result.
- Made `llms.txt` format verification CRLF-neutral and added failed-check details to CI output instead of reporting only an aggregate.
