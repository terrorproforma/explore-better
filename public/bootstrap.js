(() => {
  async function requestJson(route) {
    const response = await fetch(route, { headers: { "content-type": "application/json" } });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
    return data;
  }

  function joinEntryPath(parent, name) {
    const separator = String(parent || "").includes("\\") ? "\\" : "/";
    return `${String(parent || "").replace(/[\\/]+$/, "")}${separator}${name}`;
  }

  function bootstrapEntries(data) {
    if (Array.isArray(data?.entries)) {
      return data.entries;
    }
    if (!Array.isArray(data?.entryRows)) {
      return [];
    }
    const parent = String(data.path || "");
    const kinds = data.entryDictionaries?.kinds || [];
    return data.entryRows.map((row) => {
      const name = String(row?.[0] || "");
      const flags = Number(row?.[1] || 0);
      const isDirectory = (flags & 1) !== 0;
      return {
        name,
        path: joinEntryPath(parent, name),
        isDirectory,
        kind: String(kinds[Number(row?.[3])] || (isDirectory ? "Folder" : "File"))
      };
    });
  }

  function paintBootstrapListing(record, data) {
    const paint = () => {
      const entries = bootstrapEntries(data).slice(0, 48);
      let painted = false;
      for (const paneName of record.panes) {
        const list = document.querySelector(`[data-list="${paneName}"]`);
        if (!list || list.querySelector("[data-entry-path]") || !entries.length) continue;
        const fragment = document.createDocumentFragment();
        for (const entry of entries) {
          const row = document.createElement("div");
          row.className = "file-row bootstrap-file-row";
          row.setAttribute("role", "option");
          row.setAttribute("aria-selected", "false");
          row.setAttribute("aria-label", `${entry.isDirectory ? "Folder" : "File"}, ${entry.name}`);
          row.dataset.entryPath = String(entry.path || "");
          row.dataset.entryKind = entry.isDirectory ? "directory" : "file";
          row.dataset.pane = paneName;

          const nameCell = document.createElement("div");
          nameCell.className = "file-cell name-cell";
          const glyph = document.createElement("span");
          glyph.className = "glyph";
          glyph.textContent = entry.isDirectory ? "DIR" : "FILE";
          const name = document.createElement("span");
          name.className = "entry-name-wrap";
          name.textContent = entry.name;
          nameCell.append(glyph, name);

          const kind = document.createElement("div");
          kind.className = "file-cell";
          kind.textContent = entry.kind;
          const size = document.createElement("div");
          size.className = "file-cell numeric-cell size-cell unknown";
          const modified = document.createElement("div");
          modified.className = "file-cell";
          row.append(nameCell, kind, size, modified);
          fragment.append(row);
        }
        list.dataset.bootstrapListing = "true";
        list.append(fragment);
        painted = true;
        window.__exploreBetterPaneFirstVisibleAt ||= Object.create(null);
        window.__exploreBetterPaneFirstVisibleScheduled ||= Object.create(null);
        if (
          !Number.isFinite(window.__exploreBetterPaneFirstVisibleAt[paneName]) &&
          !window.__exploreBetterPaneFirstVisibleScheduled[paneName]
        ) {
          window.__exploreBetterPaneFirstVisibleScheduled[paneName] = true;
          requestAnimationFrame((timestamp) => {
            if (!Number.isFinite(window.__exploreBetterPaneFirstVisibleAt[paneName])) {
              window.__exploreBetterPaneFirstVisibleAt[paneName] = timestamp;
            }
            delete window.__exploreBetterPaneFirstVisibleScheduled[paneName];
          });
        }
        const input = document.querySelector(`[data-path-input="${paneName}"]`);
        if (input && !input.value) input.value = String(data.path || record.path || "");
      }
      const status = document.getElementById("status-pill");
      if (status && entries.length && painted) {
        const returned = Number(data?.window?.returned || entries.length);
        status.textContent = `${returned.toLocaleString()}+ items / loading full list`;
      }
      return painted;
    };
    // The pane lists are near the start of the document, so they are normally
    // available before the deferred application bundle finishes evaluating.
    // Paint immediately to keep that bundle off the first-visible-row path.
    paint();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", paint, { once: true });
    }
  }

  const roots = requestJson("/api/roots");
  const shellLocations = requestJson("/api/shell/locations");
  const state = requestJson("/api/state");
  window.__exploreBetterBootstrap = Promise.all([roots, shellLocations, state]);
  const initialListings = Object.create(null);
  window.__exploreBetterInitialListings = initialListings;

  const params = new URL(window.location.href).searchParams;
  // The prefetch only helps when its route is byte-for-byte the one the app's
  // first loadPane requests, so `needs` mirrors listingFetchPlan's metadata flags.
  const scheduleInitialListing = (targetPath, showHidden, paneName, needs = {}) => {
    if (!targetPath || String(targetPath).startsWith("zip://")) return;
    const query = new URLSearchParams({
      path: targetPath,
      showHidden: showHidden ? "true" : "false",
      includeDimensions: needs.dimensions ? "true" : "false",
      includeLinks: needs.links ? "true" : "false",
      includeAttributes: !showHidden || needs.attributes ? "true" : "false",
      includeSignature: "false",
      offset: "0",
      limit: "48"
    });
    const route = `/api/list?${query}`;
    const existing = initialListings[route];
    if (existing) {
      existing.panes.add(paneName);
      if (existing.data) paintBootstrapListing(existing, existing.data);
      return;
    }
    const record = {
      route,
      path: targetPath,
      panes: new Set([paneName]),
      data: null,
      consumed: 0,
      promise: null
    };
    record.promise = requestJson(route).then(
      (data) => {
        record.data = data;
        paintBootstrapListing(record, data);
        return { ok: true, data };
      },
      (error) => ({ ok: false, error })
    );
    initialListings[route] = record;
    setTimeout(() => {
      if (initialListings[route] === record) delete initialListings[route];
    }, 10000);
  };

  // Mirrors app.js normalizedPathKey / pathInsideFolder / matchingFolderFormat.
  const pathKey = (value) => String(value || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const pathInside = (candidate, folder) => {
    const candidateKey = pathKey(candidate);
    const folderKey = pathKey(folder);
    return candidateKey === folderKey || candidateKey.startsWith(`${folderKey}\\`);
  };
  const defaultColumns = ["name", "kind", "size", "modified"];
  const displayUses = (snapshot, ids) => {
    const columns = Array.isArray(snapshot?.columns) ? snapshot.columns : defaultColumns;
    return ids.some((id) => snapshot?.sortKey === id || columns.includes(id));
  };
  const listingNeeds = (tab, targetPath, loadedState) => {
    const formats = (loadedState?.folderFormats || []).filter((format) =>
      format?.path && (format.match === "subtree" ? pathInside(targetPath, format.path) : pathKey(targetPath) === pathKey(format.path))
    );
    formats.sort((a, b) => (b.match === "exact") - (a.match === "exact") || pathKey(b.path).length - pathKey(a.path).length);
    const format = formats[0]?.format || {};
    const needs = (ids) => displayUses(format, ids) || displayUses(tab, ids);
    return {
      dimensions: needs(["dimensions"]),
      links: needs(["linkType", "linkTarget"]),
      attributes: needs(["attributes"])
    };
  };
  const isAliasPath = (targetPath, loadedState) => {
    const match = String(targetPath || "").trim().match(/^([A-Za-z][A-Za-z0-9_-]{1,31}):/);
    if (!match) return false;
    const name = match[1].toLowerCase();
    return (loadedState?.aliases || []).some((alias) => alias?.path && String(alias.name || "").trim().toLowerCase() === name);
  };

  // Mirrors hydratePanesFromState + applyShellOpenParams: which tab each pane
  // opens first. Electron loads "/" or "?open=", never ?left=/?right=.
  const startupTabs = (loadedState, loadedRoots) => {
    const settings = loadedState?.settings || {};
    const explicit = ["left", "right", "open", "shellPath"].some((key) => params.has(key));
    let layout = null;
    if (!explicit) {
      const shortcut = (kind, fallback) => loadedRoots?.shortcuts?.find((item) => item.kind === kind)?.path || fallback;
      const home = loadedRoots?.home || shortcut("home", loadedRoots?.cwd);
      const pairs = {
        homeDownloads: [home, shortcut("downloads", home)],
        workspaceHome: [shortcut("workspace", loadedRoots?.cwd || home), home],
        documentsDownloads: [shortcut("documents", home), shortcut("downloads", home)]
      };
      if (settings.startupMode === "savedLayout") {
        const layoutId = typeof settings.startupLayoutId === "string" ? settings.startupLayoutId.trim().slice(0, 120) : "";
        layout = (loadedState?.layouts || []).find((item) => item.id === layoutId)?.layout || null;
      } else if (pairs[settings.startupMode]) {
        const [left, right] = pairs[settings.startupMode];
        layout = { activePane: "left", panes: { left: { tabs: [{ path: left }] }, right: { tabs: [{ path: right }] } } };
      }
    }
    layout ||= loadedState?.layout || {};
    const fallback = {
      left: params.get("left") || layout.panes?.left?.tabs?.[0]?.path || loadedRoots?.cwd,
      right: params.get("right") || layout.panes?.right?.tabs?.[0]?.path || loadedRoots?.home
    };
    const tabs = {};
    for (const paneName of ["left", "right"]) {
      const savedPane = layout.panes?.[paneName] || {};
      const savedTabs = Array.isArray(savedPane.tabs) && savedPane.tabs.length ? savedPane.tabs : [{ path: fallback[paneName] }];
      const activeIndex = params.has(paneName)
        ? 0
        : Math.max(0, Math.min(Number(savedPane.activeTab || 0), savedTabs.length - 1));
      const savedTab = activeIndex === 0 ? { ...savedTabs[0], path: fallback[paneName] } : savedTabs[activeIndex];
      tabs[paneName] = { ...(savedTab || {}), path: savedTab?.path || fallback[paneName] };
    }
    let activePane = layout.activePane === "right" ? "right" : "left";
    const openPath = params.get("open") || params.get("shellPath");
    if (openPath) {
      const mode = params.get("shellMode") || settings.shellOpenMode;
      const paneName = mode === "rightReplace"
        ? "right"
        : mode === "activeReplace" || mode === "activeNewTab" ? activePane : "left";
      tabs[paneName] = { ...tabs[paneName], path: openPath };
      activePane = paneName;
    }
    tabs.left.path ||= loadedRoots?.cwd;
    tabs.right.path ||= loadedRoots?.home;
    return { activePane, tabs };
  };

  const leftPath = params.get("left");
  const rightPath = params.get("right");
  scheduleInitialListing(leftPath || rightPath, true, "left");
  scheduleInitialListing(rightPath || leftPath, true, "right");
  Promise.all([state, roots]).then(([loadedState, loadedRoots]) => {
    const { activePane, tabs } = startupTabs(loadedState, loadedRoots);
    const showHidden = loadedState?.settings?.showHidden !== false;
    for (const paneName of [activePane, activePane === "left" ? "right" : "left"]) {
      const tab = tabs[paneName];
      if (isAliasPath(tab.path, loadedState)) continue;
      scheduleInitialListing(tab.path, showHidden, paneName, listingNeeds(tab, tab.path, loadedState));
    }
  }).catch(() => {});
})();
