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

  const isolatedContext = await fixture.request("get_context", {}, {
    context: {
      live: true,
      activePane: "left",
      paneLayout: "single",
      panes: {
        left: {
          activeTabId: "outside-tab",
          path: fixture.outside,
          tabs: [
            { id: "safe-tab", path: fixture.fixture, title: "Authorized" },
            { id: "outside-tab", path: fixture.outside, title: "Outside secret" }
          ]
        },
        right: { activeTabId: "", path: "", tabs: [] }
      },
      selection: [textPath, outsidePath],
      focusedPath: outsidePath,
      ui: {
        status: `Opening ${outsidePath}`,
        toast: { visible: true, text: "Visible feedback" },
        openDialogs: [{
          id: "test-dialog",
          title: "Test Dialog",
          summary: `3 items / restore target: ${outsidePath}`,
          state: "ready",
          modal: true,
          controls: [{ id: "browse", tag: "button", role: "button", label: "Browse", action: "data-action", actionValue: "browse" }]
        }],
        navigator: {
          visible: true,
          scroll: { clientHeight: 600, scrollHeight: 900, overflowY: "auto", scrollOwner: true },
          folderTree: {
            renderedNodes: 5,
            expandedNodes: 2,
            loadingNodes: 1,
            errorCount: 1,
            activeNodeVisible: true,
            truncated: false,
            messages: ["Loading...", `Could not read ${outsidePath}`]
          },
          sections: [{
            id: "folder-tree",
            title: "Folder Tree",
            itemCount: 2,
            scroll: { clientHeight: 240, scrollHeight: 240, overflowY: "visible", scrollOwner: false }
          }]
        }
      },
      contextRevision: 9
    }
  });
  const isolated = isolatedContext.data;
  assert(isolated.paneLayout === "single", "MCP context changed the live single-pane layout.");
  assert(isolated.panes.left.path === "" && isolated.panes.left.pathAuthorized === false, "An out-of-root active pane path was exposed.");
  assert(isolated.panes.left.tabs[0].path === fixture.fixture && isolated.panes.left.tabs[0].pathAuthorized === true, "An authorized tab path was removed.");
  assert(isolated.panes.left.tabs[1].path === "" && isolated.panes.left.tabs[1].title === "" && isolated.panes.left.tabs[1].pathAuthorized === false, "An out-of-root tab path or title was exposed.");
  assert(isolated.selection.length === 1 && isolated.selection[0] === textPath, "Out-of-root selection was not filtered.");
  assert(isolated.focusedPath === "", "Out-of-root focus was not redacted.");
  assert(isolated.ui.status === "Opening [redacted path]", "Path-bearing UI status text was not selectively redacted.");
  assert(isolated.ui.openDialogs[0].summary === "3 items / restore target: [redacted path]", "Safe dialog summary text was lost while redacting its path.");
  assert(isolated.ui.openDialogs[0].controls[0].label === "Browse", "Safe bounded UI control context was lost.");
  assert(isolated.ui.navigator.scroll.scrollOwner === true, "MCP Navigator scroll ownership was lost during context isolation.");
  assert(isolated.ui.navigator.folderTree.renderedNodes === 5 && isolated.ui.navigator.folderTree.expandedNodes === 2, "MCP Folder Tree state was lost during context isolation.");
  assert(isolated.ui.navigator.folderTree.messages[1] === "Could not read [redacted path]", "MCP Folder Tree messages exposed an unauthorized path.");
  assert(isolated.ui.navigator.sections[0].scroll.overflowY === "visible" && isolated.ui.navigator.sections[0].scroll.scrollOwner === false, "MCP nested-scroll geometry was lost during context isolation.");
  assert(isolatedContext.warnings.length > 0, "Context redaction did not report a warning.");

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

  const legacyProfile = await fixture.backend.upsertMcpProfile({
    name: "Existing saved profile",
    access: "read-only",
    roots: [fixture.fixture],
    tools: ["get_context", "set_ui_view"]
  });
  const updatedLegacyProfile = await fixture.backend.upsertMcpProfile({ id: legacyProfile.id, name: "Existing saved profile renamed" });
  assert(
    updatedLegacyProfile.tools.join(",") === "get_context,set_ui_view"
      && !updatedLegacyProfile.tools.some((name) => ["list_ui_actions", "invoke_ui_action", "wait_for_ui"].includes(name)),
    "An existing profile silently gained newly introduced semantic permissions."
  );
  const newProfile = await fixture.backend.upsertMcpProfile({ name: "New profile", access: "read-only", roots: [fixture.fixture] });
  assert(
    ["list_ui_actions", "invoke_ui_action", "wait_for_ui"].every((name) => newProfile.tools.includes(name)),
    "A newly created profile did not receive the safe semantic permission defaults."
  );

  await fixture.backend.configureMcpBridge({ enabled: false });
  await expectCode(() => fixture.backend.getMcpProfileContract(hardenedProfile.id), "BRIDGE_DISABLED");
  await expectCode(() => fixture.request("get_context"), "BRIDGE_DISABLED");
  console.log("MCP security smoke passed: roots, live-context redaction, bounded UI state, junctions, ADS, binary data, profile permission migration, discovery, and bridge disablement are enforced.");
} finally {
  await fixture.cleanup();
}

process.exit(0);
