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
  const scheduleInitialListing = (targetPath, showHidden, paneName) => {
    if (!targetPath) return;
    const query = new URLSearchParams({
      path: targetPath,
      showHidden: showHidden ? "true" : "false",
      includeDimensions: "false",
      includeLinks: "false",
      includeAttributes: showHidden ? "false" : "true",
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

  const leftPath = params.get("left");
  const rightPath = params.get("right");
  scheduleInitialListing(leftPath || rightPath, true, "left");
  scheduleInitialListing(rightPath || leftPath, true, "right");
  state.then((loadedState) => {
    const activePane = loadedState?.layout?.activePane === "right" ? "right" : "left";
    const otherPane = activePane === "left" ? "right" : "left";
    const showHidden = loadedState?.settings?.showHidden !== false;
    scheduleInitialListing(params.get(activePane) || params.get(otherPane), showHidden, activePane);
    scheduleInitialListing(params.get(otherPane) || params.get(activePane), showHidden, otherPane);
  }).catch(() => {});
})();
