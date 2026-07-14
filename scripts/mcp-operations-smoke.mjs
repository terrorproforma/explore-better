import { promises as fs } from "node:fs";
import path from "node:path";
import { assert, createBackendFixture, expectCode, waitForOperation } from "./mcp-smoke-helpers.mjs";

const fixture = await createBackendFixture({ access: "read-write" });
try {
  const target = path.join(fixture.fixture, "transaction.txt");
  await fs.writeFile(target, "original\n");
  const plan = await fixture.request("plan_text_write", { path: target, content: "updated\n" });
  const crossSession = { ...plan.data };
  await expectCode(() => fixture.request("apply_operation", { applyToken: crossSession.applyToken }, { sessionId: "foreign-session" }), "PLAN_CHANGED");

  const validPlan = await fixture.request("plan_text_write", { path: target, content: "updated\n" });
  const applied = await fixture.request("apply_operation", { applyToken: validPlan.data.applyToken });
  assert(applied.status === "accepted" && applied.data.operationId, "Apply did not return a queued operation ID.");
  await waitForOperation(fixture.request, applied.data.operationId);
  assert(await fs.readFile(target, "utf8") === "updated\n", "Transactional text write did not commit.");

  const undo = await fixture.request("undo_operation", { operationId: applied.data.operationId });
  await waitForOperation(fixture.request, undo.data.operation.id);
  assert(await fs.readFile(target, "utf8") === "original\n", "Undo did not restore the text backup.");

  const collectionPlan = await fixture.request("plan_collection_update", { action: "upsert", name: "MCP collection", paths: [target] });
  await fixture.request("apply_operation", { applyToken: collectionPlan.data.applyToken });
  const collections = await fixture.request("list_collections");
  assert(collections.data.collections.some((item) => item.name === "MCP collection"), "Collection planner did not apply.");

  const labelPlan = await fixture.request("plan_label_update", { action: "apply", paths: [target], label: "Reviewed", color: "teal" });
  await fixture.request("apply_operation", { applyToken: labelPlan.data.applyToken });
  const labels = await fixture.request("list_labels");
  assert(labels.data.labels.some((item) => item.path === target && item.name === "Reviewed"), "Label planner did not apply.");
  console.log("MCP operations smoke passed: scoped tokens, queued apply, transactional text write, undo, collections, and labels.");
} finally {
  await fixture.cleanup();
}
process.exit(0);
