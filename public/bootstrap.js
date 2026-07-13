(() => {
  async function requestJson(route) {
    const response = await fetch(route, { headers: { "content-type": "application/json" } });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
    return data;
  }

  const roots = requestJson("/api/roots");
  const shellLocations = requestJson("/api/shell/locations");
  const state = requestJson("/api/state");
  window.__exploreBetterBootstrap = Promise.all([roots, shellLocations, state]);

  state.then((loadedState) => {
    const params = new URL(window.location.href).searchParams;
    const activePane = loadedState?.layout?.activePane === "right" ? "right" : "left";
    const targetPath = params.get(activePane) || params.get(activePane === "left" ? "right" : "left");
    if (!targetPath) return;
    const showHidden = loadedState?.settings?.showHidden !== false;
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
    window.__exploreBetterInitialListing = {
      route,
      promise: requestJson(route).then(
        (data) => ({ ok: true, data }),
        (error) => ({ ok: false, error })
      )
    };
  }).catch(() => {});
})();
