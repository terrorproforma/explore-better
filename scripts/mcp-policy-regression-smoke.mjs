import { promises as fs } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createBackendFixture, expectCode, waitForOperation, waitFor } from "./mcp-smoke-helpers.mjs";

const fixture = await createBackendFixture({ access: "read-write", allowPermanentDelete: true });
const checks = [];
const check = (name, condition, details) => {
  assert(condition, details ? `${name}\n${JSON.stringify(details, null, 2)}` : name);
  checks.push(name);
};
const reset = () => fixture.backend.upsertMcpProfile({ id: fixture.profile.id, roots: [fixture.fixture], allowPermanentDelete: true });
try {
  const target = path.join(fixture.fixture, "draft.txt");
  const narrow = path.join(fixture.fixture, "Remaining folder");
  await fs.mkdir(narrow);
  await fs.writeFile(target, "original");
  const plan = await fixture.request("plan_text_write", { path: target, content: "new content" });
  await fixture.backend.upsertMcpProfile({ id: fixture.profile.id, roots: [narrow] });
  await expectCode(() => fixture.request("apply_operation", { applyToken: plan.data.applyToken }), "PLAN_CHANGED");
  check("Narrowed roots invalidate previews without changing the file", await fs.readFile(target, "utf8") === "original");
  await reset();

  const deletion = await fixture.request("plan_delete", { paths: [target], mode: "permanent" });
  await fixture.backend.upsertMcpProfile({ id: fixture.profile.id, allowPermanentDelete: false });
  await expectCode(() => fixture.request("apply_operation", { applyToken: deletion.data.applyToken }), "PLAN_CHANGED");
  check("Disabling permanent deletion invalidates its existing preview", await fs.readFile(target, "utf8") === "original");
  await reset();

  await expectCode(() => fixture.request("read_text", { path: target }, { clientRoots: [], clientRootsProvided: true }), "OUTSIDE_ROOTS");
  check("Explicit empty client roots grant no filesystem scope", true);
  check("Clients without roots retain configured profile scope", (await fixture.request("read_text", { path: target })).data.text === "original");

  const concurrent = await fixture.backend.upsertMcpProfile({ name: "Revocation fixture", roots: [fixture.fixture] });
  await Promise.all([
    fixture.backend.revokeMcpProfile(concurrent.id),
    ...Array.from({ length: 8 }, (_, index) => fixture.backend.upsertMcpProfile({ name: `Concurrent ${index}`, roots: [narrow] }))
  ]);
  const config = await fixture.backend.getMcpBridgeConfiguration();
  check("Concurrent changes preserve revocation", config.profiles.find(item => item.id === concurrent.id)?.enabled === false);
  check("Concurrent profile creation loses no entries", config.profiles.filter(item => item.name.startsWith("Concurrent ")).length === 8);

  // Keep this input in the original TEMP spelling to exercise short-path authorization.
  const requestedTarget = path.join(fixture.requestedTemp, path.relative(fixture.temp, target));
  const writePlan = await fixture.request("plan_text_write", { path: requestedTarget, content: "saved" });
  const applied = await fixture.request("apply_operation", { applyToken: writePlan.data.applyToken });
  const operation = await waitForOperation(fixture.request, applied.data.operationId);
  // Authorization persists real paths; Windows TEMP can use an 8.3 alias.
  const canonicalTarget = await fs.realpath(requestedTarget);
  const policy = operation.mcpPolicy;
  check("Operation records persist their authorized paths and policy",
    policy?.paths?.length === 1 && policy.paths[0] === canonicalTarget &&
    /^[a-f0-9]{64}$/.test(policy.signature || "") && policy.planningTool === "plan_text_write",
    { requestedPath: requestedTarget, canonicalTarget, operationId: operation.id, storedPolicy: policy ?? null });
  await fixture.backend.upsertMcpProfile({ id: fixture.profile.id, roots: [narrow] });
  await expectCode(() => fixture.request("get_operation", { operationId: operation.id }), "PLAN_CHANGED");
  await expectCode(() => fixture.request("undo_operation", { operationId: operation.id }), "PLAN_CHANGED");
  await expectCode(() => fixture.request("control_operation", { operationId: operation.id, action: "retry" }), "PLAN_CHANGED");
  check("Changed permissions protect operation details, retry and Undo", await fs.readFile(target, "utf8") === "saved");
  await reset();
  const undo = await fixture.request("undo_operation", { operationId: operation.id });
  await waitForOperation(fixture.request, undo.data.operation.id);
  check("Undo remains usable under matching current permissions", await fs.readFile(target, "utf8") === "original");

  const otherTarget = path.join(fixture.outside, "other.txt");
  await fs.writeFile(otherTarget, "other fixture");
  const other = await fixture.backend.upsertMcpProfile({ name: "Other collection", access: "read-write", roots: [fixture.outside] });
  const otherRequest = (tool, args) => fixture.request(tool, args, { profileId: other.id });
  const collectionPlan = await otherRequest("plan_collection_update", { action: "upsert", name: "Other files", paths: [otherTarget] });
  await otherRequest("apply_operation", { applyToken: collectionPlan.data.applyToken });
  const collection = (await otherRequest("list_collections", {})).data.collections.find(item => item.name === "Other files");
  await expectCode(() => fixture.request("plan_collection_update", { action: "delete", id: collection.id }), "OUTSIDE_ROOTS");
  await expectCode(() => fixture.request("plan_collection_update", { action: "upsert", id: collection.id, name: "Replacement", paths: [target] }), "OUTSIDE_ROOTS");
  check("Collection replacement/deletion authorizes existing contents", (await otherRequest("list_collections", {})).data.collections.some(item => item.id === collection.id));

  const job = (await fixture.request("compute_checksums", { paths: [target] })).data.job.id;
  await waitFor(async () => (await fixture.request("get_job", { jobId: job })).data.status === "complete");
  await fixture.backend.upsertMcpProfile({ id: fixture.profile.id, roots: [narrow] });
  await expectCode(() => fixture.request("get_job", { jobId: job }), "PLAN_CHANGED");
  check("Stored analysis results retain scope protection", true);
  await reset();

  let executions = 0, describedPath = otherTarget;
  await fixture.backend.setMcpUiDispatcher(async action => {
    if (action.type === "describe") return { paths: [describedPath], contextRevision: 1, descriptionToken: describedPath };
    executions++;
    check("Renderer execution is bound to described revision", action.expectedContextRevision === 1);
    check("Renderer execution is bound to described targets", action.expectedDescriptionToken === describedPath);
    return { path: target, priorPath: otherTarget, nested: { root: otherTarget }, contextRevision: 2 };
  });
  await expectCode(() => fixture.request("invoke_ui_action", { actionId: "pane.refresh", inputs: {} }), "OUTSIDE_ROOTS");
  check("Implicit UI targets are authorized before execution", executions === 0);
  describedPath = target;
  const ui = await fixture.request("invoke_ui_action", { actionId: "pane.refresh", inputs: {} });
  check("UI result paths are scoped", ui.data.path === target && ui.data.priorPath === "" && ui.data.nested.root === "");
  const status = await fixture.request("get_index_status", {});
  check("Index status omits internal cache paths", !JSON.stringify(status).includes("cacheRoot"));

  console.log(`MCP policy regression: ${checks.length} passed.`);
  await fs.writeFile(path.resolve("artifacts/mcp-policy-regression-latest.json"), JSON.stringify({ pass: checks.length, checks }, null, 2));
} finally {
  await fixture.backend.setMcpUiDispatcher(null);
  await fixture.cleanup();
}
process.exit(0);
