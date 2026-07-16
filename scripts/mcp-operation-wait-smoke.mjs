import { promises as fs } from "node:fs";
import path from "node:path";
import { assert, startElectronMcp, waitFor } from "./mcp-smoke-helpers.mjs";

const toolData = (response) => response?.result?.structuredContent?.data;
const serialized = (response) => JSON.stringify(response?.result || response || {});

let harness;
try {
  harness = await startElectronMcp({
    visible: true,
    access: "read-write",
    prepareFixture: async (fixture) => {
      const source = path.join(fixture, "operation-source");
      const target = path.join(fixture, "operation-target");
      await fs.mkdir(source, { recursive: true });
      await fs.mkdir(target, { recursive: true });
      const payload = Buffer.alloc(256 * 1024, 0x45);
      for (let offset = 0; offset < 256; offset += 16) {
        await Promise.all(Array.from({ length: 16 }, (_, index) => fs.writeFile(path.join(source, `item-${String(offset + index).padStart(3, "0")}.bin`), payload)));
      }
      return { source, target };
    }
  });
  const callTool = (name, args = {}) => harness.call("tools/call", { name, arguments: args });
  await waitFor(async () => toolData(await callTool("get_context"))?.live, 30_000, 150);

  const plan = await callTool("plan_transfer", {
    mode: "copy",
    paths: [harness.preparedFixture.source],
    targetDir: harness.preparedFixture.target,
    conflictMode: "fail"
  });
  const applyToken = toolData(plan)?.applyToken;
  assert(applyToken, `Transfer planning failed: ${serialized(plan)}`);
  const applied = await callTool("apply_operation", { applyToken });
  const operationId = toolData(applied)?.operationId;
  assert(operationId, `Applying the transfer failed: ${serialized(applied)}`);

  const uri = `explore-better://operations/${operationId}`;
  const subscription = await harness.call("resources/subscribe", { uri });
  assert(!subscription.error, `Operation resource subscription failed: ${serialized(subscription)}`);
  const waitStartedAt = performance.now();
  const completed = await callTool("wait_for_ui", {
    timeoutMs: 30_000,
    condition: { operationId, operationStatus: "completed" }
  });
  const elapsedMs = performance.now() - waitStartedAt;
  assert(toolData(completed)?.matched === true && toolData(completed)?.operation?.status === "completed", `Operation wait did not match completion: ${serialized(completed)}`);
  const notification = await waitFor(
    () => harness.notifications.find((item) => item.method === "notifications/resources/updated" && item.params?.uri === uri),
    5_000,
    40
  );
  assert(Object.keys(notification.params || {}).every((key) => key === "uri"), "Operation notification included unsolicited operation data.");
  const resource = await harness.call("resources/read", { uri });
  assert(!resource.error && resource.result?.contents?.[0]?.uri === uri, `Operation resource could not be reread: ${serialized(resource)}`);
  const operation = toolData(await callTool("get_operation", { operationId }))?.operation;
  assert(operation?.events?.some((event) => event.kind === "completed"), "Completed MCP operation omitted its timeline completion event.");
  assert(operation.events.length <= 64, `Operation timeline exceeded its 64-event bound: ${operation.events.length}.`);
  await harness.call("resources/unsubscribe", { uri });

  console.log(`MCP operation wait smoke passed: completion matched in ${elapsedMs.toFixed(1)} ms with URI-only subscription wake-up and bounded timeline.`);
} finally {
  await harness?.close();
}
