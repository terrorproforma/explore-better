# Explore Better Devlog

## 2026-07-14 21:25 +10:00 - AI discovery and MCP value proof

- Added a real Electron/Go-sidecar MCP-versus-PowerShell benchmark with deterministic ground truth, three measured repetitions, machine-readable evidence, and an explicit warm-shell limitation.
- Added a crawlable MCP technical page, benchmark JSON/Markdown, canonical and social metadata, `SoftwareApplication` JSON-LD, `robots.txt`, `sitemap.xml`, `llms.txt`, and `llms-full.txt`.
- Added `verify:mcp-value` and `verify:seo-discovery`, wired both into Windows CI, and synchronized the visible benchmark table from the published JSON.
- Updated README, user manual, release notes, GitHub description, homepage, and repository topics for Windows file-manager and MCP discovery.
- Validation: MCP contract, security, context, analysis, operations, performance, and value suites passed; landing page passed 40/40; SEO discovery passed 56/56 at desktop/mobile sizes with OAI-SearchBot endpoint checks.
- Final consolidated validation: `verify:all` passed 44/44, release readiness passed 31/31, speed health passed 175/175, packaged MCP matched the source sidecar, and the goal audit completed with 0 failures.
- Remaining release limitation: the public Windows preview is still unsigned, and official MCP Registry publication needs an independently supported package artifact rather than the current app-bundled sidecar.
