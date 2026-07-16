export async function clickDockAction(page, actionId, options = {}) {
  const selector = `.command-dock [data-global-action="${actionId}"]`;
  const direct = page.locator(selector);
  if (await direct.isVisible()) {
    try {
      await direct.click({ ...options, timeout: Math.min(options.timeout || 10000, 1000) });
      return "shelf";
    } catch {
      // Responsive measurement can move a command into overflow between the
      // visibility probe and Playwright's actionability check. Fall through
      // to the stable overflow dispatch path.
    }
  }
  const timeout = options.timeout || 10000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const toggle = page.locator("#dock-overflow-toggle");
    await toggle.waitFor({ state: "visible", timeout: Math.max(1, deadline - Date.now()) });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.click();
    }
    const overflow = page.locator(`#dock-overflow-menu [data-overflow-global-action="${actionId}"]`);
    try {
      await overflow.waitFor({ state: "visible", timeout: Math.min(1000, Math.max(1, deadline - Date.now())) });
      // Responsive dock measurement may replace the menu item between
      // Playwright's actionability checks. Dispatch against the latest node;
      // the application still handles the same click event and command path.
      await overflow.dispatchEvent("click");
      return "overflow";
    } catch {
      await page.waitForTimeout(25);
    }
  }
  throw new Error(`Dock action ${actionId} did not become stable within ${timeout}ms.`);
}
