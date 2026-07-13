export async function clickDockAction(page, actionId, options = {}) {
  const selector = `.command-dock [data-global-action="${actionId}"]`;
  const direct = page.locator(selector);
  if (await direct.isVisible()) {
    await direct.click(options);
    return "shelf";
  }
  const toggle = page.locator("#dock-overflow-toggle");
  await toggle.waitFor({ state: "visible", timeout: options.timeout || 10000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  const overflow = page.locator(`#dock-overflow-menu [data-overflow-global-action="${actionId}"]`);
  await overflow.waitFor({ state: "visible", timeout: options.timeout || 10000 });
  await overflow.click(options);
  return "overflow";
}
