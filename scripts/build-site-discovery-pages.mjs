import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const siteRoot = path.join(root, "site");
const baseUrl = "https://terrorproforma.github.io/explore-better";
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const releaseTag = `v${packageJson.version}`;
const benchmark = JSON.parse(await fs.readFile(path.join(siteRoot, "benchmarks", "mcp-value.json"), "utf8"));
const benchmarkById = new Map(benchmark.workflows.map((workflow) => [workflow.id, workflow]));
const benchmarkMetric = (id, side) => benchmarkById.get(id)?.[side]?.medianMs ?? "n/a";
const benchmarkRatio = (id) => {
  const workflow = benchmarkById.get(id);
  return workflow ? Math.round((workflow.powershell.medianMs / workflow.mcp.medianMs) * 10) / 10 : "n/a";
};

const integrations = {
  claude: {
    label: "Claude Desktop",
    title: "Use Explore Better with Claude Desktop",
    description: "Connect Claude Desktop to a folder-scoped Explore Better MCP profile for live file context, structured analysis, and previewed operations on Windows.",
    config: `%APPDATA%\\Claude\\claude_desktop_config.json`,
    proof: "Claude receives typed file entries, current pane context, durable jobs, and explicit operation plans instead of brittle command output."
  },
  cursor: {
    label: "Cursor",
    title: "Use Explore Better with Cursor",
    description: "Give Cursor structured access to authorized Windows folders through the local Explore Better MCP server, indexes, and safe operation planner.",
    config: `%USERPROFILE%\\.cursor\\mcp.json`,
    proof: "Cursor can inspect project trees, compare folders, find duplicates, and reveal results in the live Explore Better workspace."
  },
  codex: {
    label: "Codex",
    title: "Use Explore Better with Codex",
    description: "Connect Codex to the local Explore Better MCP sidecar for active-pane context, indexed file discovery, disk analysis, and recoverable file operations.",
    config: `%USERPROFILE%\\.codex\\config.toml`,
    proof: "Codex can work with exact paths and structured results while Explore Better remains the authority for permissions, previews, journaling, and undo."
  },
  vscode: {
    label: "VS Code",
    title: "Use Explore Better with VS Code",
    description: "Add Explore Better to the VS Code MCP configuration and give coding agents safe, local access to selected Windows folders and analysis tools.",
    config: `%APPDATA%\\Code\\User\\mcp.json`,
    proof: "VS Code agents can search and inspect files beyond one workspace without receiving unrestricted access to the rest of the machine."
  },
  chatgpt: {
    label: "ChatGPT",
    title: "Use Explore Better with ChatGPT and OpenAI clients",
    description: "Explore Better exposes a standards-based local MCP server for OpenAI clients that support local stdio MCP connections, with Codex setup available today.",
    config: `Use AI Bridge > Set up Codex, or the generic stdio configuration shown in Explore Better.`,
    proof: "The MCP contract is client-neutral. Availability in a particular ChatGPT surface depends on that surface supporting local stdio MCP servers."
  }
};

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cards(items) {
  return `<div class="detail-grid">${items.map((item) => `<article><h3>${item[0]}</h3><p>${item[1]}</p></article>`).join("")}</div>`;
}

function steps(items) {
  return `<ol class="detail-steps">${items.map((item, index) => `<li><span>0${index + 1}</span><strong>${item[0]}</strong><small>${item[1]}</small></li>`).join("")}</ol>`;
}

function section(title, intro, body, dark = false) {
  return `<section class="detail-section${dark ? " detail-section--dark" : ""}"><div class="page-shell"><p class="eyebrow${dark ? " light" : ""}">Explore Better</p><h2>${title}</h2><p class="detail-prose">${intro}</p>${body}</div></section>`;
}

const pages = [
  {
    slug: "ai-file-manager-windows",
    title: "AI-native Windows file manager and Explorer replacement",
    description: "Explore Better combines a fast dual-pane Windows file manager with a local MCP server so humans and AI can share live folder context and safe file operations.",
    eyebrow: "A new file-manager category",
    lede: "A real Explorer replacement for you. A structured, permissioned file workspace for your AI.",
    sections: [
      section("A shared view of the filesystem", "Terminal agents know what commands printed. Explore Better gives an AI the same active panes, tabs, selection, authorized roots, indexes, and operation history that you can see.", cards([
        ["For people", "Dual panes, tabs, native listing, per-tab terminals, visual disk analysis, search, previews, and reversible Explorer integration."],
        ["For AI clients", "Thirty-two typed MCP tools plus 22 selector-free semantic actions for context, discovery, analysis, safe UI control, planning, operations, progress, cancellation, and undo."],
        ["One authority", "Explore Better owns Windows permissions, root policy, path validation, transaction journals, recovery records, and the visible workspace."]
      ])),
      section("More useful than terminal-only access", "A terminal is still available in every tab, but reliable file work benefits from typed pagination, durable jobs, exact errors, and plans that can be inspected before anything changes.", cards([
        ["No shell parsing", "File entries, checksums, duplicate groups, folder comparisons, and Analyzer results return as bounded structured data."],
        ["No invisible writes", "Mutation tools plan first. Apply tokens expire, are one-use, and bind the current paths, policy, plan digest, and filesystem signatures."],
        ["No separate AI filesystem", "The AI works through the same indexes, Analyzer, operations queue, recovery system, and pane state as the desktop app."],
        ["No screen scraping", "Stable semantic actions expose validated inputs, disabled reasons, stale-context protection, visible outcomes, and event-driven waits without selectors or scripts."]
      ]) + `<div class="benchmark-strip"><div><strong>${benchmarkRatio("filename-search")}x</strong><span>filename search median</span></div><div><strong>${benchmarkRatio("disk-usage")}x</strong><span>disk analysis median</span></div><div><strong>${benchmarkRatio("duplicate-space")}x</strong><span>duplicate search median</span></div><p>Compared with equivalent fresh PowerShell processes on the same deterministic fixture, three measured runs. A warm persistent shell may be faster. See the published benchmark for method and raw timings.</p></div>`, true),
      section("Start local and read-only", "Install the Windows app, enable AI Bridge, authorize one folder, and connect the client you already use.", steps([
        ["Install", "Run the per-user Windows installer. Normal browsing and AI Bridge use do not require administrator rights."],
        ["Authorize", "Create a read-only profile for exact folders and tools. Each profile has a separate revocable ID."],
        ["Connect", "Use the built-in Codex, Claude, Cursor, or VS Code setup action, then call get_context or list_directory."]
      ]))
    ]
  },
  {
    slug: "mcp-file-manager",
    title: "A local MCP file manager for Windows",
    description: "Explore Better MCP gives AI clients typed file context, indexed search, disk analysis, duplicate finding, comparisons, and previewed recoverable operations.",
    eyebrow: "Thirty-two typed tools / 22 semantic actions / local stdio",
    lede: "Reliable AI file work without arbitrary shell execution, cloud file uploads, or unrestricted machine access.",
    sections: [
      section("Tools built around real file workflows", "The MCP sidecar is a thin adapter. Explore Better remains the authority for filesystem state, policy, indexing, transactions, and recovery.", cards([
        ["Context and discovery", "Read active pane context, list locations and directories, search indexes, inspect paths, read bounded text, and compute checksums."],
        ["Analysis", "Run durable disk-usage, duplicate, and folder-comparison jobs with progress, cancellation, and paginated results."],
        ["Safe operations", "Plan transfers, rename, delete, archive, create, text writes, labels, and collections; then apply, monitor, control, or undo."],
        ["Semantic UI control", "List stable actions, invoke validated in-app behavior, wait for structured outcomes, and reject stale context without DOM selectors."]
      ]) + `<div class="benchmark-strip"><div><strong>${benchmarkMetric("filename-search", "mcp")} ms</strong><span>typed filename search median</span></div><div><strong>${benchmarkMetric("disk-usage", "mcp")} ms</strong><span>exact disk analysis median</span></div><div><strong>${benchmarkMetric("duplicate-space", "mcp")} ms</strong><span>duplicate job median</span></div><p>All three workflows matched ground truth. Equivalent fresh PowerShell baselines measured ${benchmarkMetric("filename-search", "powershell")} ms, ${benchmarkMetric("disk-usage", "powershell")} ms, and ${benchmarkMetric("duplicate-space", "powershell")} ms respectively. A warm persistent shell may be faster.</p></div>`),
      section("A deliberately narrow security boundary", "The server uses local stdio and an authenticated same-user named pipe. It has no remote HTTP transport, arbitrary shell tool, terminal control, registry mutation, or AI-controlled elevation.", cards([
        ["Exact roots", "Effective access intersects per-client profile roots, client roots when supplied, and Windows permissions after canonicalization."],
        ["Read-first", "Profiles default to read-only. Permanent deletion and writable tools are separate permissions, disabled unless selected."],
        ["Auditable", "A rotating local audit records the client, tool, paths, policy decision, duration, and job or operation IDs, never file contents or tokens."]
      ]), true),
      section("Install the standalone MCP bundle", "The Windows MCPB release contains the native stdio sidecar, manifest, tool catalogue, prompts, screenshots, license, and SHA-256 metadata.", `<pre class="detail-code">Registry name: io.github.terrorproforma/explore-better\nTransport: stdio\nPlatform: Windows x64\nProfile: required, separately revocable\nApp: auto-discovered from the normal per-user install</pre><p><a class="button button--primary" href="https://github.com/terrorproforma/explore-better/releases/tag/${releaseTag}">Download the MCPB release</a></p>`)
    ]
  },
  {
    slug: "integrations",
    title: "Connect Explore Better to your AI client",
    description: "Set up the local Explore Better MCP server for Codex, Claude Desktop, Cursor, VS Code, ChatGPT-compatible clients, or any stdio MCP host.",
    eyebrow: "AI client integrations",
    lede: "One local file authority, separate folder-scoped profiles for every client.",
    sections: [
      section("First-class setup paths", "Explore Better edits supported client configuration structurally, preserves unrelated servers, and makes a byte-for-byte backup before its first change.", cards(Object.entries(integrations).map(([key, item]) => [`<a href="${key}/">${item.label}</a>`, item.description]))),
      section("The same safety model everywhere", "A client name never grants trust. Every connection is constrained by its own profile, authorized roots, tool permissions, limits, and write policy.", steps([
        ["Create a profile", "Choose authorized folders and keep the default read-only mode for initial use."],
        ["Install config", "Select the client in AI Bridge and use its setup button, or copy the generic stdio snippet."],
        ["Test and revoke", "Call get_context, inspect the audit entry, and revoke the profile whenever access is no longer needed."]
      ]), true)
    ]
  },
  ...Object.entries(integrations).map(([slug, item]) => ({
    slug: `integrations/${slug}`,
    title: item.title,
    description: item.description,
    eyebrow: `${item.label} / local MCP on Windows`,
    lede: item.proof,
    sections: [
      section(`Connect ${item.label} in three steps`, "The desktop app creates the profile first, so credentials and authorized roots never need to appear in a public URL or copied command.", steps([
        ["Enable AI Bridge", "Open Preferences > AI Bridge and turn on the local bridge."],
        ["Create a profile", "Authorize exact folders, choose read-only or planned writes, and copy the generated profile ID."],
        ["Set up the client", `Use the ${item.label} setup action. Explore Better updates ${esc(item.config)} while preserving unrelated configuration.`]
      ])),
      section("What the client gains", "The client sees a stable, bounded tool model rather than a general-purpose shell.", cards([
        ["Live context", "Read the active pane, tabs, selection, focus, layout, and context revision when the desktop window is open."],
        ["Fast discovery", "Page directories, query persistent indexes, inspect metadata, read bounded text, and compute checksums."],
        ["Safe execution", "Run analysis jobs or preview a file change, apply it through the transactional queue, and monitor or undo the result."]
      ]), true),
      section("A good first test", "Open a folder in Explore Better, select a few files, then ask the client to inspect the current context and identify the largest selected item without modifying anything.", `<pre class="detail-code">Use Explore Better's get_context tool.\nInspect the visible selection.\nReturn the largest item and explain which structured fields support the answer.\nDo not modify any files.</pre>`)
    ]
  })),
  {
    slug: "use-cases/organize-downloads-safely",
    title: "Organize Downloads safely with AI on Windows",
    description: "Use Explore Better and a local AI client to inspect, classify, preview, and apply recoverable organization plans for a busy Downloads folder.",
    eyebrow: "Practical workflow / Downloads",
    lede: "Let AI do the inventory and planning while Explore Better keeps every change visible, bounded, and recoverable.",
    sections: [
      section("A safer organization loop", "Authorize only the Downloads folder, begin read-only, and ask for evidence before enabling write tools.", steps([
        ["Investigate", "List and inspect files, group by type and age, find duplicates, and identify partial downloads without changing anything."],
        ["Preview", "Create a transfer and rename plan. Review destinations, conflicts, estimated work, and the short-lived apply token."],
        ["Apply or revise", "Approve the operation through the transactional queue, or change the rules and generate a fresh plan."]
      ])),
      section("Why this beats a generated shell script", "The plan is bound to current filesystem signatures, the destination is staged before commit, and interruption produces deterministic recovery choices.", cards([
        ["Bounded scope", "The profile cannot escape the one authorized folder through traversal, junctions, device paths, or alternate data streams."],
        ["Conflict visibility", "Existing destinations and policy choices appear in the plan instead of being buried in command flags."],
        ["Recovery and undo", "Journalled operations can be monitored, canceled, reconciled after a crash, and undone when supported."]
      ]), true)
    ]
  },
  {
    slug: "use-cases/find-disk-space",
    title: "Find what is using disk space with AI",
    description: "Explore Better combines exact Windows allocated-size analysis, a nested disk treemap, duplicate finding, and typed MCP results for AI-guided cleanup.",
    eyebrow: "Practical workflow / disk space",
    lede: "See the shape of the disk yourself, then let AI compare the evidence without handing it an unrestricted shell.",
    sections: [
      section("From volume to exact file", "The native Windows provider reports logical bytes, allocated bytes, cluster size, and the accuracy source so sparse or compressed files are not mislabeled.", cards([
        ["Nested treemap", "Drill from broad folders into individual files while folder, extension, and top-file tables stay synchronized."],
        ["Durable AI job", "Start analysis through MCP, poll progress, cancel quickly, and page results without materializing a huge volume in the client."],
        ["Duplicate evidence", "Group identical checksums, inspect locations, and prepare a deletion plan only after reviewing what is actually redundant."]
      ])),
      section("Analysis is not deletion", "The Analyzer and duplicate tools are read-only. Cleanup requires a separate write-enabled profile, a current plan, and explicit apply.", steps([
        ["Scan", "Analyze the target folder or volume and inspect the largest allocations and duplicate groups."],
        ["Decide", "Exclude system, application state, backup, and irreplaceable paths. Choose Recycle Bin where supported."],
        ["Plan", "Generate a delete or transfer preview, review signatures and conflicts, then approve or abandon it."]
      ]), true)
    ]
  },
  {
    slug: "security",
    title: "Explore Better security model",
    description: "How Explore Better protects local file access, MCP profiles, previewed writes, Electron IPC, terminal elevation, and recovery data on Windows.",
    eyebrow: "Security / local-first boundaries",
    lede: "Powerful local tools should expose less authority than the user who launched them, not more.",
    sections: [
      section("Separate boundaries for separate jobs", "The renderer, local backend, filesystem helper, terminal service, elevated terminal broker, and MCP sidecar each receive only the interface needed for their role.", cards([
        ["Desktop boundary", "The Electron renderer uses a narrow preload bridge; navigation and external links are restricted, and the HTTP backend is loopback-only with a launch capability."],
        ["MCP boundary", "Local stdio forwards typed requests over an authenticated, same-user named pipe keyed to a revocable profile."],
        ["Elevation boundary", "The main app stays non-elevated. A UAC-approved headless broker owns exactly one administrator ConPTY session when explicitly requested."]
      ])),
      section("Writes are transactions", "Copies, moves, overwrites, and AI-planned mutations use staging, backups, durable journal phases, source-removal tracking, cancellation, recovery, and undo.", cards([
        ["Plan binding", "Apply tokens bind the profile, session, operation, normalized paths, conflict policy, plan digest, and filesystem signatures."],
        ["Path controls", "Canonicalization and reparse-point resolution block root escape, device paths, alternate streams, app state, journals, and drive-root deletion."],
        ["Local audit", "Thirty-day rotating records capture policy and operation metadata without storing file contents or capability tokens."]
      ]), true)
    ]
  },
  {
    slug: "privacy",
    title: "Explore Better privacy policy",
    description: "Explore Better is local-first software. Learn what the app, AI Bridge, website, and GitHub release distribution do and do not collect.",
    eyebrow: "Privacy / effective July 14, 2026",
    lede: "Explore Better does not operate a cloud file service. Your browsing state, file contents, terminal sessions, and MCP traffic remain on your Windows device.",
    prose: `<h2>Local application data</h2><p>The app stores preferences, indexes, caches, operation journals, recovery records, client profiles, and local audit metadata under the current Windows user account. These records support the features you enable and are not sent to an Explore Better server.</p><h2>AI Bridge</h2><p>The MCP sidecar communicates locally over stdio and an authenticated same-user named pipe. Explore Better does not upload MCP requests, tool results, file contents, profile secrets, or capability tokens. Your chosen AI client may process tool inputs and results under that client's own privacy terms.</p><h2>Website and releases</h2><p>The static website is hosted by GitHub Pages and release files are hosted by GitHub Releases. GitHub may process request logs and account data under its own policies. The site contains no Explore Better analytics, advertising trackers, or account system.</p><h2>Control and deletion</h2><p>You can revoke individual AI profiles, clear local audit history and caches, disable Explorer integration, and uninstall the app. Uninstall options determine whether local settings are retained. Repository questions can be raised through the public issue tracker.</p>`
  },
  {
    slug: "terms",
    title: "Explore Better terms of use",
    description: "Terms for downloading, using, modifying, and redistributing the Explore Better Windows file manager and local MCP server.",
    eyebrow: "Terms / effective July 14, 2026",
    lede: "Explore Better is open-source preview software distributed under the MIT License.",
    prose: `<h2>License</h2><p>The source code and bundled MCP distribution are provided under the MIT License in the project repository. That license grants broad permission to use, copy, modify, merge, publish, distribute, sublicense, and sell copies, subject to its notice requirements.</p><h2>Preview software</h2><p>The current release is a public preview and is provided without warranty. File operations can carry inherent risk. Keep independent backups, review previews and paths, verify release hashes, and do not grant AI clients broader roots or write permissions than their task requires.</p><h2>Third-party services</h2><p>GitHub, Windows, and connected AI clients are independent products governed by their own terms. Explore Better does not guarantee availability or behavior of third-party integrations.</p><h2>Abuse and support</h2><p>Do not use the software to access data without authorization or to bypass Windows permissions. Issues and security reports may be submitted through the repository's documented channels. The MIT License remains the controlling software license.</p>`
  }
];

function renderPage(page) {
  const depth = page.slug.split("/").length;
  const prefix = "../".repeat(depth);
  const canonical = `${baseUrl}/${page.slug}/`;
  const body = page.prose
    ? `<section class="detail-section"><div class="page-shell detail-prose">${page.prose}</div></section>`
    : page.sections.join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${esc(page.description)}" />
    <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1" />
    <meta name="theme-color" content="#111715" />
    <meta property="og:title" content="${esc(page.title)} - Explore Better" />
    <meta property="og:description" content="${esc(page.description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${baseUrl}/assets/workspace.png" />
    <title>${esc(page.title)} - Explore Better</title>
    <link rel="canonical" href="${canonical}" />
    <link rel="alternate" type="text/plain" href="${baseUrl}/llms.txt" title="Explore Better LLM index" />
    <link rel="icon" type="image/svg+xml" href="${prefix}assets/brand-mark.svg" />
    <link rel="icon" type="image/png" href="${prefix}assets/app-icon.png" />
    <link rel="stylesheet" href="${prefix}styles.css" />
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "SoftwareApplication", "@id": `${baseUrl}/#software`, name: "Explore Better", operatingSystem: "Windows 11 x64", applicationCategory: "UtilitiesApplication" },
        { "@type": "WebPage", name: page.title, description: page.description, url: canonical, isPartOf: { "@type": "WebSite", name: "Explore Better", url: `${baseUrl}/` }, about: { "@id": `${baseUrl}/#software` } }
      ]
    })}</script>
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>
    <header class="site-header detail-header">
      <a class="brand" href="${prefix}" aria-label="Explore Better home"><img src="${prefix}assets/brand-mark.svg" alt="" width="44" height="42" /><span>Explore Better</span></a>
      <nav class="site-nav" aria-label="Primary navigation"><a href="${prefix}ai-file-manager-windows/">Human + AI</a><a href="${prefix}mcp-file-manager/">MCP server</a><a href="${prefix}integrations/">Integrations</a><a href="${prefix}mcp/">Proof</a></nav>
      <a class="header-download" href="${prefix}#download"><img src="${prefix}assets/icons/download.svg" alt="" width="18" height="18" /><span>Download</span></a>
    </header>
    <main class="detail-main" id="main">
      <section class="detail-hero"><div class="page-shell"><p class="eyebrow light">${page.eyebrow}</p><h1>${page.title}</h1><p class="detail-hero__lede">${page.lede}</p><div class="hero__actions"><a class="button button--primary" href="${prefix}#download">Download for Windows</a><a class="button button--ghost" href="${prefix}mcp/">See measured proof</a></div></div></section>
      ${body}
    </main>
    <footer class="site-footer"><div class="page-shell footer-layout"><a class="brand brand--footer" href="${prefix}"><img src="${prefix}assets/brand-mark.svg" alt="" width="44" height="42" /><span>Explore Better</span></a><p>The Windows file manager built for humans and AI.</p><div class="footer-links"><a href="${prefix}security/">Security</a><a href="${prefix}privacy/">Privacy</a><a href="${prefix}terms/">Terms</a><a href="https://github.com/terrorproforma/explore-better">Source</a></div><small>MIT licensed</small></div></footer>
  </body>
</html>`;
}

for (const page of pages) {
  const directory = path.join(siteRoot, ...page.slug.split("/"));
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "index.html"), renderPage(page), "utf8");
}

const sitemapUrls = [
  { path: "", priority: "1.0" },
  { path: "mcp/", priority: "0.9" },
  ...pages.map((page) => ({ path: `${page.slug}/`, priority: page.slug === "ai-file-manager-windows" || page.slug === "mcp-file-manager" ? "0.9" : "0.8" }))
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.map((item) => `  <url>
    <loc>${baseUrl}/${item.path}</loc>
    <lastmod>2026-07-14</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${item.priority}</priority>
  </url>`).join("\n")}
</urlset>
`;
await fs.writeFile(path.join(siteRoot, "sitemap.xml"), sitemap, "utf8");

console.log(`Generated ${pages.length} focused discovery pages and ${sitemapUrls.length} sitemap entries.`);
