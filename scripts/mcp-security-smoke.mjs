import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, createBackendFixture, expectCode, removeTreeEventually, waitFor } from "./mcp-smoke-helpers.mjs";

// The write policy reads %APPDATA% when the automation service starts, so point
// it at a disposable folder before the fixture creates the service.
const roaming = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "eb-mcp-roaming-")));
const previousAppData = process.env.APPDATA;
process.env.APPDATA = roaming;
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
  assert(isolated.ui.status === "" && isolated.ui.toast.text === "" && isolated.ui.toast.visible === true, "Free-form UI status or toast text was exposed while a visible pane is outside the authorized roots.");
  assert(isolated.ui.openDialogs[0].summary === "3 items / restore target: [redacted path]", "Safe dialog summary text was lost while redacting its path.");
  assert(isolated.ui.openDialogs[0].controls[0].label === "Browse", "Safe bounded UI control context was lost.");
  assert(isolated.ui.navigator.scroll.scrollOwner === true, "MCP Navigator scroll ownership was lost during context isolation.");
  assert(isolated.ui.navigator.folderTree.renderedNodes === 5 && isolated.ui.navigator.folderTree.expandedNodes === 2, "MCP Folder Tree state was lost during context isolation.");
  assert(isolated.ui.navigator.folderTree.messages[1] === "Could not read [redacted path]", "MCP Folder Tree messages exposed an unauthorized path.");
  assert(isolated.ui.navigator.sections[0].scroll.overflowY === "visible" && isolated.ui.navigator.sections[0].scroll.scrollOwner === false, "MCP nested-scroll geometry was lost during context isolation.");
  assert(isolatedContext.warnings.length > 0, "Context redaction did not report a warning.");

  const authorizedContext = await fixture.request("get_context", {}, {
    context: {
      live: true,
      activePane: "left",
      paneLayout: "single",
      panes: { left: { activeTabId: "", path: fixture.fixture, tabs: [] }, right: { activeTabId: "", path: fixture.outside, tabs: [] } },
      ui: { status: `Opening ${outsidePath}`, toast: { visible: true, text: "Copied 2 items" } },
      contextRevision: 10
    }
  });
  assert(authorizedContext.data.ui.status === "Opening [redacted path]" && authorizedContext.data.ui.toast.text === "Copied 2 items", "UI status text was lost while every visible pane is authorized.");

  // A network path outside every root is rejected textually: no realpath (and
  // so no SMB authentication) happens, and the answer does not depend on
  // whether the path exists.
  const realpathCalls = [];
  const originalRealpath = fs.realpath;
  fs.realpath = (target, ...rest) => {
    realpathCalls.push(String(target));
    return originalRealpath.call(fs, target, ...rest);
  };
  try {
    for (const uncPath of ["//203.0.113.1/s/x", "\\\\203.0.113.1\\share\\secret.txt"]) {
      const started = Date.now();
      await expectCode(() => fixture.request("read_text", { path: uncPath }), "OUTSIDE_ROOTS");
      assert(Date.now() - started < 200, "A UNC path outside the roots was not rejected before network access.");
    }
    await expectCode(() => fixture.request("read_text", { path: path.join(fixture.outside, "missing.txt") }), "OUTSIDE_ROOTS");
  } finally {
    fs.realpath = originalRealpath;
  }
  assert(!realpathCalls.some((item) => /^[\\/]{2}/.test(item)), `A UNC path reached realpath: ${realpathCalls.join(", ")}`);

  const searchFolder = path.join(fixture.fixture, "search-pages");
  await fs.mkdir(searchFolder);
  for (let index = 0; index < 7; index += 1) await fs.writeFile(path.join(searchFolder, `paged-${index}.txt`), "x");
  const seen = new Set();
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const result = await fixture.request("search_files", { path: searchFolder, query: "paged", limit: 2, ...(cursor ? { cursor } : {}) });
    for (const entry of result.data.entries) seen.add(entry.path);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  assert(seen.size === 7, `Search pagination returned ${seen.size} of 7 results.`);

  // Internal state: ancestors stay listable, the internal subtree stays hidden.
  const localAppData = process.env.LOCALAPPDATA;
  const internalRoot = path.join(localAppData, "ExploreBetter");
  await fs.mkdir(internalRoot, { recursive: true });
  await fs.writeFile(path.join(localAppData, "visible.txt"), "visible\n");
  const ancestorProfile = await fixture.backend.upsertMcpProfile({ name: "Ancestor root", access: "read-only", roots: [localAppData] });
  const ancestorListing = await fixture.request("list_directory", { path: localAppData }, { profileId: ancestorProfile.id });
  const listedNames = ancestorListing.data.entries.map((entry) => entry.name);
  assert(listedNames.includes("visible.txt"), "An ancestor of the internal state folder could not be listed.");
  assert(!listedNames.includes("ExploreBetter"), "The internal state folder appeared in an ancestor listing.");
  await expectCode(() => fixture.request("list_directory", { path: internalRoot }, { profileId: ancestorProfile.id }), "OUTSIDE_ROOTS");

  const writer = await fixture.backend.upsertMcpProfile({ name: "Security writer", access: "read-write", roots: [fixture.fixture, roaming] });
  const write = (tool, args) => fixture.request(tool, args, { profileId: writer.id });
  const waitOperation = (operationId) => waitFor(async () => {
    const operation = (await write("get_operation", { operationId })).data.operation;
    return ["completed", "failed", "canceled"].includes(operation.status) ? operation : null;
  }, 60_000);

  // Archive creation writes exactly the previewed archive path, even when the
  // source is an authorized root whose parent is outside the profile.
  const packRoot = path.join(fixture.fixture, "pack-root");
  const archiveRoot = path.join(fixture.fixture, "archives");
  await fs.mkdir(packRoot);
  await fs.mkdir(archiveRoot);
  await fs.writeFile(path.join(packRoot, "packed.txt"), "packed\n");
  const archiveWriter = await fixture.backend.upsertMcpProfile({ name: "Archive writer", access: "read-write", roots: [packRoot, archiveRoot] });
  const archivePlan = await fixture.request("plan_archive", { action: "create", paths: [packRoot], archivePath: path.join(archiveRoot, "bundle") }, { profileId: archiveWriter.id });
  assert(archivePlan.data.summary.archivePath === path.join(archiveRoot, "bundle.zip"), "The archive preview did not show the .zip path that will be written.");
  const archiveApply = await fixture.request("apply_operation", { applyToken: archivePlan.data.applyToken }, { profileId: archiveWriter.id });
  const archiveOperation = await waitFor(async () => {
    const operation = (await fixture.request("get_operation", { operationId: archiveApply.data.operationId }, { profileId: archiveWriter.id })).data.operation;
    return ["completed", "failed", "canceled"].includes(operation.status) ? operation : null;
  }, 60_000);
  assert(archiveOperation.status === "completed", `Archive creation failed: ${archiveOperation.error || archiveOperation.status}`);
  assert(await fs.stat(path.join(archiveRoot, "bundle.zip")).then(() => true, () => false), "The archive was not written to the previewed path.");
  assert(!(await fs.stat(path.join(fixture.fixture, "pack-root.zip")).then(() => true, () => false)), "The archive was written beside its source, outside the authorized roots.");

  // Sync items are authorized one by one, so a junction inside a root cannot
  // carry a copy outside it.
  const left = path.join(fixture.fixture, "sync-left");
  const right = path.join(fixture.fixture, "sync-right");
  await fs.mkdir(path.join(left, "linked"), { recursive: true });
  await fs.mkdir(right, { recursive: true });
  await fs.writeFile(path.join(left, "linked", "payload.txt"), "payload\n");
  await fs.symlink(fixture.outside, path.join(right, "linked"), "junction");
  await expectCode(() => write("plan_transfer", { mode: "sync", leftPath: left, rightPath: right, direction: "left-to-right", paths: ["linked/payload.txt"] }), "OUTSIDE_ROOTS");
  await expectCode(() => write("plan_transfer", { mode: "sync", leftPath: left, rightPath: right, direction: "left-to-right", paths: ["../outside.txt"] }), "INVALID_ARGUMENT");

  // A dangling junction is resolved to where a create would really land.
  await fs.symlink(path.join(fixture.outside, "missing-folder"), path.join(fixture.fixture, "dangling"), "junction");
  await expectCode(() => write("plan_text_write", { path: path.join(fixture.fixture, "dangling", "created.txt"), content: "x" }), "OUTSIDE_ROOTS");
  await expectCode(() => write("plan_create", { kind: "folder", path: fixture.fixture, name: "dangling" }), "OUTSIDE_ROOTS");

  // Startup folders and managed MCP client configuration files are read-only to
  // MCP clients, without any approval prompt.
  const startup = path.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const claudeConfig = path.join(roaming, "Claude", "claude_desktop_config.json");
  await fs.mkdir(startup, { recursive: true });
  await fs.mkdir(path.dirname(claudeConfig), { recursive: true });
  await fs.writeFile(claudeConfig, "{}\n");
  await expectCode(() => write("plan_text_write", { path: path.join(startup, "launch.cmd"), content: "calc\n" }), "WRITE_POLICY_DENIED");
  await expectCode(() => write("plan_create", { kind: "shortcut", path: startup, targets: [textPath] }), "WRITE_POLICY_DENIED");
  await expectCode(() => write("plan_transfer", { mode: "copy", paths: [textPath], targetDir: startup }), "WRITE_POLICY_DENIED");
  await expectCode(() => write("plan_text_write", { path: claudeConfig, content: "{\"mcpServers\":{}}\n" }), "WRITE_POLICY_DENIED");
  await expectCode(() => write("plan_delete", { paths: [path.dirname(claudeConfig)], mode: "trash" }), "WRITE_POLICY_DENIED");
  const configRead = await write("read_text", { path: claudeConfig });
  assert(configRead.data.text === "{}\n", "The write policy blocked reading a client configuration file.");
  const allowedWrite = await write("plan_text_write", { path: path.join(roaming, "notes.txt"), content: "ok\n" });
  assert(allowedWrite.status === "planned", "The write policy blocked an ordinary write beside protected folders.");

  // MCP linkType values reach the operation service as its linkKind values.
  const linkFolder = path.join(fixture.fixture, "links");
  await fs.mkdir(linkFolder);
  const linkPlan = await write("plan_create", { kind: "link", path: linkFolder, targets: [textPath], linkType: "symbolic" });
  const linkApply = await write("apply_operation", { applyToken: linkPlan.data.applyToken });
  const linkOperation = await waitOperation(linkApply.data.operationId);
  const created = linkOperation.result?.created?.[0];
  if (linkOperation.status === "completed") {
    assert(created?.linkKind === "symlink" && (await fs.lstat(created.dest)).isSymbolicLink(), "A requested symbolic link was not created as a symbolic link.");
  } else {
    // Creating symbolic links needs Developer Mode or elevation; the request
    // must still have asked for a symbolic link instead of falling back.
    assert(/"linkKind":"symlink"/.test(JSON.stringify(linkOperation)) && !/hard link/i.test(String(linkOperation.error || "")), `A symbolic link request was not forwarded as linkKind symlink: ${linkOperation.error}`);
  }

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
  console.log("MCP security smoke passed: roots, UNC rejection, live-context redaction, bounded UI state, junctions, dangling links, sync items, archive placement, write deny-list, link kinds, internal state, search paging, ADS, binary data, profile permission migration, discovery, and bridge disablement are enforced.");
} finally {
  await fixture.cleanup();
  if (previousAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousAppData;
  await removeTreeEventually(roaming).catch(() => {});
}

process.exit(0);
