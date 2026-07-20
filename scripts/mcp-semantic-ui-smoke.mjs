import path from "node:path";
import { assert, startElectronMcp, waitFor } from "./mcp-smoke-helpers.mjs";

const toolData = (response) => response?.result?.structuredContent?.data;
const serialized = (response) => JSON.stringify(response?.result || response || {});
const toolFailed = (response, code = "") => Boolean(response?.error || response?.result?.isError) && (!code || serialized(response).includes(code));

let harness;
try {
  harness = await startElectronMcp({ visible: true });
  const callTool = (name, args = {}) => harness.call("tools/call", { name, arguments: args });
  const live = await waitFor(async () => {
    const response = await callTool("get_context");
    return toolData(response)?.live ? response : null;
  }, 30_000, 150);
  const catalogResponse = await callTool("list_ui_actions", { includeDisabled: true });
  const catalog = toolData(catalogResponse)?.actions || [];
  assert(catalog.length >= 20, `Semantic catalog is unexpectedly small: ${catalog.length}.`);
  assert(catalog.every((item) => item.id && item.inputSchema?.type === "object" && item.outcome && typeof item.enabled === "boolean"), "Semantic catalog entries are incomplete.");
  assert(catalog.some((item) => item.id === "pane.activate" && item.enabled), "Pane activation is missing from the semantic catalog.");
  assert(catalog.some((item) => item.enabled === false && item.disabledReason), "Disabled semantic actions do not explain why they are unavailable.");
  assert(!catalog.some((item) => /retry|undo|terminal|elevat|registry|preference.*save/i.test(item.id)), "The semantic catalog exposes an excluded privileged action.");

  const activationContext = toolData(await callTool("get_context"));
  const targetPane = activationContext.activePane === "left" ? "right" : "left";
  let expectedContextRevision = activationContext.contextRevision;
  let activated;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    activated = await callTool("invoke_ui_action", {
      actionId: "pane.activate",
      pane: targetPane,
      inputs: {},
      expectedContextRevision
    });
    if (!toolFailed(activated, "STALE_CONTEXT")) break;
    expectedContextRevision = toolData(await callTool("get_context"))?.contextRevision;
  }
  const activatedData = toolData(activated);
  assert(!activated.result?.isError && activatedData?.actionId === "pane.activate" && activatedData?.correlationId, `Pane activation failed: ${serialized(activated)}`);
  const traced = await waitFor(async () => {
    const response = await callTool("get_context");
    const context = toolData(response);
    return context?.activePane === targetPane && context.ui?.lastInteraction?.correlationId === activatedData.correlationId ? response : null;
  }, 10_000, 100);
  assert(toolData(traced).ui.lastInteraction.source === "mcp", "MCP semantic action was not correlated to its resulting UI context.");

  await callTool("invoke_ui_action", { actionId: "pane.activate", pane: targetPane === "left" ? "right" : "left", inputs: {} });
  const stale = await callTool("invoke_ui_action", { actionId: "pane.refresh", pane: targetPane, inputs: {}, expectedContextRevision: 1 });
  assert(toolFailed(stale, "STALE_CONTEXT"), `Selection-sensitive action accepted a stale revision: ${serialized(stale)}`);
  const invalid = await callTool("invoke_ui_action", { actionId: "tab.select", pane: targetPane, inputs: { index: "first" } });
  assert(toolFailed(invalid, "INVALID_ARGUMENT"), `Invalid semantic inputs were accepted: ${serialized(invalid)}`);
  const excluded = await callTool("invoke_ui_action", { actionId: "operation.retry", pane: targetPane, inputs: {} });
  assert(toolFailed(excluded, "UNKNOWN_ACTION"), `Excluded operation control was invokable: ${serialized(excluded)}`);
  const unauthorized = await callTool("invoke_ui_action", { actionId: "folderTree.toggle", inputs: { path: path.dirname(harness.fixture) } });
  assert(toolFailed(unauthorized), "Semantic action accepted a path outside the profile roots.");

  await callTool("set_ui_view", { view: "preferences", visible: true });
  const blockedCatalog = toolData(await callTool("list_ui_actions", { view: "navigator", includeDisabled: true }))?.actions || [];
  assert(blockedCatalog.find((item) => item.id === "folderTree.refresh")?.enabled === false, "Blocking dialog did not disable Folder Tree refresh.");
  const blocked = await callTool("invoke_ui_action", { actionId: "folderTree.refresh", inputs: {} });
  assert(toolFailed(blocked, "UI_PRECONDITION"), `Blocked semantic action unexpectedly ran: ${serialized(blocked)}`);
  await callTool("set_ui_view", { view: "preferences", visible: false });

  const beforeWait = toolData(await callTool("get_context"));
  const waitTarget = beforeWait.activePane === "left" ? "right" : "left";
  const waitStartedAt = performance.now();
  const waitCall = callTool("wait_for_ui", {
    afterRevision: beforeWait.contextRevision,
    timeoutMs: 5_000,
    condition: { activePane: waitTarget }
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await callTool("invoke_ui_action", { actionId: "pane.activate", pane: waitTarget, inputs: {} });
  const waited = await waitCall;
  const waitElapsedMs = performance.now() - waitStartedAt;
  assert(toolData(waited)?.matched === true && toolData(waited)?.context?.activePane === waitTarget, `wait_for_ui did not wake for the structured condition: ${serialized(waited)}`);
  assert(waitElapsedMs < 1_000, `wait_for_ui wake-up was too slow: ${waitElapsedMs.toFixed(1)} ms.`);

  const timeout = await callTool("wait_for_ui", {
    afterRevision: toolData(waited).context.contextRevision,
    timeoutMs: 120,
    condition: { statusIncludes: "status-that-will-never-exist" }
  });
  assert(toolData(timeout)?.matched === false && timeout.result?.structuredContent?.status === "partial", `wait_for_ui timeout did not return a partial latest context: ${serialized(timeout)}`);

  const subscription = await harness.call("resources/subscribe", { uri: "explore-better://context/current" });
  assert(!subscription.error, `Context resource subscription failed: ${serialized(subscription)}`);
  await callTool("invoke_ui_action", { actionId: "pane.activate", pane: waitTarget === "left" ? "right" : "left", inputs: {} });
  const notification = await waitFor(() => harness.notifications.find((item) => item.method === "notifications/resources/updated" && item.params?.uri === "explore-better://context/current"), 5_000, 50);
  assert(notification.params.uri === "explore-better://context/current" && Object.keys(notification.params).every((key) => ["uri"].includes(key)), "Resource update notification leaked data instead of sending only the changed URI.");
  await harness.call("resources/unsubscribe", { uri: "explore-better://context/current" });

  const healthResource = await harness.call("resources/read", { uri: "explore-better://health/current" });
  const healthText = String(healthResource.result?.contents?.[0]?.text || "");
  assert(!healthResource.error && /health/i.test(healthText), `Health resource could not be read: ${serialized(healthResource)}`);
  assert(
    !healthText.includes(harness.fixture) && !/hello\.txt|applyToken|capability|bridgeNonce|terminal output/i.test(healthText),
    "Health resource exposed a path, filename, terminal content, or bridge secret."
  );

  const pendingWait = harness.startCall("tools/call", {
    name: "wait_for_ui",
    arguments: { timeoutMs: 30_000, condition: { statusIncludes: "cancel-this-wait" } }
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const canceledAt = performance.now();
  harness.writeSidecar({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: pendingWait.id, reason: "test cancellation" } });
  const canceled = await pendingWait.promise;
  assert(performance.now() - canceledAt < 1_000 && toolFailed(canceled), `Canceled wait did not abort promptly: ${serialized(canceled)}`);

  console.log(`MCP semantic UI smoke passed: ${catalog.length} actions, wait wake ${waitElapsedMs.toFixed(1)} ms, stale/input/auth/dialog/exclusion/subscription/cancellation boundaries enforced.`);
} finally {
  await harness?.close();
}
