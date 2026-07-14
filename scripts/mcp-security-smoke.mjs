import { promises as fs } from "node:fs";
import path from "node:path";
import { assert, createBackendFixture, expectCode } from "./mcp-smoke-helpers.mjs";

const fixture = await createBackendFixture({ access: "read-only" });
try {
  const textPath = path.join(fixture.fixture, "safe.txt");
  const outsidePath = path.join(fixture.outside, "outside.txt");
  await fs.writeFile(textPath, "safe\n");
  await fs.writeFile(outsidePath, "outside\n");
  await fs.writeFile(path.join(fixture.fixture, "binary.bin"), Buffer.from([0, 1, 0, 2, 0, 3, 255]));
  await fs.symlink(fixture.outside, path.join(fixture.fixture, "escape"), "junction");

  const rootAlias = path.join(fixture.temp, "authorized-alias");
  await fs.symlink(fixture.fixture, rootAlias, "junction");
  const aliasedProfile = await fixture.backend.upsertMcpProfile({ name: "Aliased root", access: "read-only", roots: [rootAlias] });
  const aliasedRead = await fixture.request("read_text", { path: textPath }, { profileId: aliasedProfile.id });
  assert(aliasedRead.data.text === "safe\n", "A canonical child path was rejected for an authorized aliased root.");

  await expectCode(() => fixture.request("read_text", { path: outsidePath }), "OUTSIDE_ROOTS");
  await expectCode(() => fixture.request("read_text", { path: path.join(fixture.fixture, "escape", "outside.txt") }), "OUTSIDE_ROOTS");
  await expectCode(() => fixture.request("read_text", { path: `${textPath}:stream` }), "INVALID_PATH");
  await expectCode(() => fixture.request("read_text", { path: path.join(fixture.fixture, "binary.bin") }), "BINARY_FILE");
  await expectCode(() => fixture.request("plan_delete", { paths: [textPath], mode: "trash" }), "TOOL_NOT_ALLOWED");
  await expectCode(() => fixture.request("get_context", {}, { profileId: "forged-profile" }), "UNKNOWN_PROFILE");

  const hardenedProfile = await fixture.backend.upsertMcpProfile({
    ...fixture.profile,
    access: "read-only",
    tools: [...fixture.profile.tools, "plan_create", "apply_operation"]
  });
  assert(!hardenedProfile.tools.includes("plan_create") && !hardenedProfile.tools.includes("apply_operation"), "Read-only profile sanitization retained write tools.");
  const profileContract = await fixture.backend.getMcpProfileContract(hardenedProfile.id);
  assert(profileContract.tools.length === hardenedProfile.tools.length, "Profile contract did not match the effective tool permissions.");
  assert(profileContract.tools.every((tool) => hardenedProfile.tools.includes(tool.name) && tool.access !== "write"), "Profile contract exposed a forbidden tool.");
  await expectCode(() => fixture.backend.getMcpProfileContract("forged-profile"), "UNKNOWN_PROFILE");

  await fixture.backend.configureMcpBridge({ enabled: false });
  await expectCode(() => fixture.backend.getMcpProfileContract(hardenedProfile.id), "BRIDGE_DISABLED");
  await expectCode(() => fixture.request("get_context"), "BRIDGE_DISABLED");
  console.log("MCP security smoke passed: roots, junctions, ADS, binary data, profile-scoped discovery, and bridge disablement are enforced.");
} finally {
  await fixture.cleanup();
}
