const panes = {
  left: createPaneState(),
  right: createPaneState()
};

const app = {
  activePane: "left",
  paneLayout: "vertical",
  roots: null,
  shellLocations: null,
  shellNamespace: { target: "thisPc", stack: [], report: null, loading: false },
  state: null,
  integrationStatus: null,
  activeToolId: null,
  activeScriptId: null,
  activeHotkeyId: null,
  activeCollectionId: null,
  activePaneSnapshotId: null,
  activeSelectionSetId: null,
  activeAliasId: null,
  activeTabGroupId: null,
  activeFolderFormatId: null,
  activeDisplayPresetId: null,
  activeFilterPresetId: null,
  activeSyncProfileId: null,
  activeOpenWithPresetId: null,
  activeSearchPresetId: null,
  activeSelectPresetId: null,
  activeBulkRenamePresetId: null,
  activeFavoriteId: null,
  historyDialog: { paneName: "left" },
  contextMenu: null,
  closedTabs: [],
  dragTransfer: null,
  columnResize: null,
  tabDrag: null,
  dockDrag: null,
  fileClipboard: { mode: null, paths: [], sourcePane: null, sourcePath: null, capturedAt: null },
  inlineRename: null,
  lastEntryOpen: null,
  layoutResize: null,
  quickSearch: { paneName: null, mode: "filter", query: "", activeIndex: 0 },
  manual: { text: "", loadedAt: 0, query: "" },
  speed: {
    paneName: "left",
    status: null,
    search: null,
    background: null,
    backgroundSearch: null,
    jobId: null,
    pollTimer: null,
    backgroundPollTimer: null
  },
  sizeAnalysis: {
    paneName: "left",
    report: null,
    loading: false,
    controller: null,
    requestId: 0,
    treemapRects: [],
    treemapHover: null,
    treemapSelection: null,
    treemapFocusPath: "",
    viewMode: "overview",
    sizeMode: "logical",
    colorMode: "type"
  },
  pathSuggest: { paneName: null, items: [], activeIndex: 0, keyboardSelected: false, requestId: 0 },
  breadcrumbMenu: { paneName: null, path: null, entries: [], loading: false, error: null, requestId: 0, x: 0, y: 0 },
  selectMask: { paneName: "left", pattern: "" },
  lastLabelColor: "teal",
  compareResult: null,
  compareSyncPreview: null,
  bulkRename: null,
  transfer: null,
  destination: null,
  archive: null,
  link: null,
  attributes: null,
  timestamps: null,
  properties: null,
  openWith: null,
  shellVerbs: null,
  copyNames: null,
  checksums: null,
  newFile: null,
  duplicateResult: null,
  textEditor: null,
  viewer: { paneName: "left", path: null, entries: [], index: -1, preview: null },
  commandPalette: { items: [], activeIndex: 0, view: "all", pins: new Set(), recents: [], loaded: false },
  operationDetails: { id: null, selectedRemaining: new Set(), selectedBackups: new Set() },
  fileBasket: { selected: new Set() },
  trashBrowser: {
    mode: "app",
    items: [],
    selected: new Set(),
    summary: null,
    windowsItems: [],
    windowsSelected: new Set(),
    windowsSummary: null
  },
  folderTree: { expanded: new Set(), nodes: new Map(), loading: new Set(), leafPaths: new Set() },
  paneLoads: {
    left: { id: 0, controller: null, phase: "idle", text: "Ready", detail: "Left pane ready" },
    right: { id: 0, controller: null, phase: "idle", text: "Ready", detail: "Right pane ready" }
  },
  virtualLists: { left: null, right: null },
  virtualRenderFrames: { left: null, right: null },
  renderTokens: { left: 0, right: 0 },
  thumbnailObservers: { left: null, right: null },
  listingCache: new Map(),
  listingCacheGeneration: 0,
  listingHydrations: new Map(),
  inspectorRenderToken: 0,
  inspectorPreviewController: null,
  listingPrefetch: { queue: [], queued: new Set(), active: new Map() },
  visibleEntryCache: new WeakMap(),
  sharedVisibleEntryCache: new WeakMap(),
  visibleEntryIndexes: new WeakMap(),
  visibleEntryPathSets: new WeakMap(),
  currentLabelEntriesCache: new WeakMap(),
  operationPollTimer: null,
  operationPollBusy: false,
  autoRefreshTimer: null,
  autoRefreshBusy: false,
  typeahead: { paneName: null, value: "", lastAt: 0 },
  toastTimer: null,
  saveTimer: null,
  scriptTemplate: `console.log("Path:", context.path);
console.log("Other:", context.otherPath);
console.log("Selected:", context.selectedPaths);
await api.emit("script:started", { activePane: context.activePane });

const listing = await api.list(context.path);
return listing.entries
  .filter((item) => item.isFile)
  .slice(0, 8)
  .map((item) => ({ name: item.name, size: item.size }));`
};

installDialogFallback();
enhanceDialogAccessibility();

function installDialogFallback() {
  const dialogPrototype =
    window.HTMLDialogElement?.prototype || Object.getPrototypeOf(document.createElement("dialog"));
  if (!dialogPrototype) return;
  if (typeof dialogPrototype.showModal !== "function") {
    dialogPrototype.showModal = function showModalFallback() {
      this.setAttribute("open", "");
      this.open = true;
    };
  }
  if (typeof dialogPrototype.close !== "function") {
    dialogPrototype.close = function closeFallback(returnValue = "") {
      this.returnValue = returnValue;
      this.removeAttribute("open");
      this.open = false;
      this.dispatchEvent(new Event("close"));
    };
  }
}

function readableIdText(value) {
  return String(value || "dialog")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function enhanceDialogAccessibility() {
  document.querySelectorAll("dialog").forEach((dialog) => {
    if (!dialog.hasAttribute("aria-modal")) {
      dialog.setAttribute("aria-modal", "true");
    }
    const title = dialog.querySelector(".dialog-head strong, .dialog-head h1, .dialog-head h2, .dialog-head h3");
    if (!dialog.hasAttribute("aria-label") && !dialog.hasAttribute("aria-labelledby")) {
      if (title) {
        if (!title.id) {
          title.id = `${dialog.id || "dialog"}-title`;
        }
        dialog.setAttribute("aria-labelledby", title.id);
      } else {
        dialog.setAttribute("aria-label", readableIdText(dialog.id));
      }
    }
    const titleText = title?.textContent?.trim() || readableIdText(dialog.id);
    dialog.querySelectorAll("[data-close-dialog]").forEach((button) => {
      if (!button.getAttribute("aria-label")) {
        button.setAttribute("aria-label", `Close ${titleText}`);
      }
    });
  });
  const commandInput = document.getElementById("command-input");
  if (commandInput && !commandInput.getAttribute("aria-label")) {
    commandInput.setAttribute("aria-label", "Command search");
  }
  document.querySelectorAll("button[title]").forEach((button) => {
    if (button.getAttribute("aria-label")) {
      return;
    }
    const title = button.getAttribute("title")?.trim();
    const text = button.textContent.trim();
    const iconLike = button.classList.contains("icon-button") || text.length <= 2 || /^[^\w]+$/.test(text);
    if (title && iconLike) {
      button.setAttribute("aria-label", title);
    }
  });
}

const viewerPreviewTypes = new Set(["image", "text", "pdf", "audio", "video"]);
const viewerPreviewKinds = new Set(["Image", "Text", "Audio", "Video"]);
const listingCacheTtlMs = 8000;
const listingCacheMaxEntries = 24;
const listingWindowInitialLimit = 48;
const listingPrefetchMaxActive = 2;
const listingPrefetchMaxQueue = 8;
const listingPrefetchDelayMs = 120;
const paneValueCollator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const layoutSizeDefaults = {
  navWidth: 236,
  inspectorWidth: 300,
  leftPaneWeight: 1,
  rightPaneWeight: 1,
  topPaneWeight: 1,
  bottomPaneWeight: 1,
  dockHeight: 44
};
const virtualRenderThreshold = 1800;
const virtualOverscanRows = 14;
const virtualTileMinWidth = 128;
const virtualTileHeight = 184;
const virtualTileGap = 10;
const virtualTilePadding = 10;
const zipVirtualPrefix = "zip://";
const zipPaneEntryLimit = 100000;
const listingCacheInvalidatingRoutes = new Set([
  "/api/archive/create",
  "/api/archive/extract",
  "/api/attributes/set",
  "/api/bulk-rename",
  "/api/command/run",
  "/api/copy",
  "/api/delete",
  "/api/file/create",
  "/api/link/create",
  "/api/mkdir",
  "/api/move",
  "/api/operation/backup-recovery",
  "/api/operation/elevated-retry",
  "/api/operation/retry",
  "/api/operation/retry-remaining",
  "/api/operation/retry-selected",
  "/api/operation/undo",
  "/api/recycle",
  "/api/rename",
  "/api/script",
  "/api/shortcut/create",
  "/api/shell/verb",
  "/api/sync",
  "/api/text/save",
  "/api/timestamps/set",
  "/api/transfer",
  "/api/trash",
  "/api/app-trash/delete",
  "/api/app-trash/restore"
]);
const operationPreviewRoutes = new Set([
  "/api/operation/preview",
  "/api/transfer/preview",
  "/api/bulk-rename/preview",
  "/api/shell/open",
  "/api/shell/namespace/open"
]);
const kindFilterOptions = [
  { value: "all", label: "All" },
  { value: "folders", label: "Folders" },
  { value: "files", label: "Files" },
  { value: "images", label: "Images" },
  { value: "text", label: "Text" },
  { value: "documents", label: "Docs" },
  { value: "media", label: "Media" },
  { value: "archives", label: "Archives" },
  { value: "apps", label: "Apps" }
];
const kindFilterValues = new Set(kindFilterOptions.map((option) => option.value));
const favoriteColorValues = new Set(["teal", "gold", "ember", "violet", "green", "black"]);
const commandCenterStorageKey = "explore-better-command-center-v1";

const commands = [
  {
    name: "Copy selected to other pane",
    detail: "Copies the active selection into the opposite pane path.",
    run: () => copyToOther(app.activePane)
  },
  {
    name: "Copy selection to clipboard",
    detail: "Stores selected paths for app paste and the Windows file clipboard.",
    run: () => copySelectionToClipboard(app.activePane)
  },
  {
    name: "Cut selection to clipboard",
    detail: "Marks selected paths to move on the next app or Windows paste.",
    run: () => cutSelectionToClipboard(app.activePane)
  },
  {
    name: "Paste clipboard here",
    detail: "Pastes the app or Windows file clipboard into the active pane path.",
    run: () => pasteFileClipboard(app.activePane)
  },
  {
    name: "Clear file clipboard",
    detail: "Clears the app-owned file clipboard.",
    run: () => clearFileClipboard()
  },
  {
    name: "Toggle hidden items",
    detail: "Shows or hides hidden and system filesystem entries in real folder panes.",
    run: () => updateShowHiddenSetting(!showHiddenEntriesEnabled())
  },
  {
    name: "Show all item kinds",
    detail: "Clears the active pane kind filter.",
    run: () => setKindFilter(app.activePane, "all")
  },
  {
    name: "Filter pane to folders",
    detail: "Shows only folders in the active pane.",
    run: () => setKindFilter(app.activePane, "folders")
  },
  {
    name: "Filter pane to images",
    detail: "Shows only image files in the active pane.",
    run: () => setKindFilter(app.activePane, "images")
  },
  {
    name: "Filter pane to media",
    detail: "Shows audio and video files in the active pane.",
    run: () => setKindFilter(app.activePane, "media")
  },
  {
    name: "Open filter presets",
    detail: "Saves or applies reusable text, kind, and label pane filters.",
    run: () => openFilterPresetsDialog(app.activePane)
  },
  {
    name: "Save current filter preset",
    detail: "Captures the active pane text, kind, and label filters.",
    run: () => quickSaveFilterPreset(app.activePane)
  },
  {
    name: "Copy names to Windows clipboard",
    detail: "Formats the selected paths or active folder as names, paths, CSV, or JSON.",
    run: () => openCopyNamesDialog(app.activePane)
  },
  {
    name: "Copy full paths to Windows clipboard",
    detail: "Copies selected full paths as newline text to the Windows clipboard.",
    run: () => copyNamesQuick(app.activePane, "path")
  },
  {
    name: "Create checksum manifest",
    detail: "Hashes selected files and builds manifest, CSV, or JSON checksum text.",
    run: () => openChecksumsDialog(app.activePane)
  },
  {
    name: "Verify checksum manifest",
    detail: "Checks a selected manifest, CSV, or JSON checksum file against files beside it.",
    run: async () => {
      openChecksumsDialog(app.activePane);
      await verifyChecksumManifest();
    }
  },
  {
    name: "Move selected to other pane",
    detail: "Moves the active selection into the opposite pane path.",
    run: () => moveToOther(app.activePane)
  },
  {
    name: "Vertical split panes",
    detail: "Shows left and right panes side by side.",
    run: () => setPaneLayout("vertical")
  },
  {
    name: "Horizontal split panes",
    detail: "Stacks left and right panes for wide file names and previews.",
    run: () => setPaneLayout("horizontal")
  },
  {
    name: "Single active pane",
    detail: "Focuses the active pane while keeping the other pane state intact.",
    run: () => setPaneLayout("single")
  },
  {
    name: "Transfer selected with policy",
    detail: "Previews copy or move with rename, overwrite, or skip conflict handling.",
    run: () => openTransferDialog(app.activePane)
  },
  {
    name: "Send selection to destination",
    detail: "Copies or moves selected items to favorites, recents, roots, or a typed folder.",
    run: () => openDestinationDialog(app.activePane)
  },
  {
    name: "Create ZIP from selection",
    detail: "Archives selected files or folders into a ZIP in the opposite pane.",
    run: () => openArchiveDialog(app.activePane)
  },
  {
    name: "Extract selected ZIP",
    detail: "Extracts the first selected ZIP into a folder in the opposite pane.",
    run: () => openArchiveDialog(app.activePane)
  },
  {
    name: "New folder",
    detail: "Creates a folder in the active pane.",
    run: () => newFolder(app.activePane)
  },
  {
    name: "New file",
    detail: "Creates an undoable text file in the active pane.",
    run: () => openNewFileDialog(app.activePane)
  },
  {
    name: "Create Windows shortcut",
    detail: "Creates .lnk shortcuts for the active selection in the active folder.",
    run: () => createShortcutsForSelection(app.activePane)
  },
  {
    name: "Create filesystem link",
    detail: "Creates hard links, junctions, or symbolic links for the active selection.",
    run: () => openLinkDialog(app.activePane)
  },
  {
    name: "Rename selected",
    detail: "Renames the first selected item.",
    run: () => renameSelected(app.activePane)
  },
  {
    name: "Bulk rename selected",
    detail: "Previews and applies batch rename rules to selected items.",
    run: () => openBulkRenameDialog(app.activePane)
  },
  {
    name: "Trash selected",
    detail: "Moves selected items into the app trash folder.",
    run: () => trashSelected(app.activePane)
  },
  {
    name: "Recycle selected in Windows",
    detail: "Moves selected items to the Windows Recycle Bin and records the operation.",
    run: () => recycleSelected(app.activePane)
  },
  {
    name: "Delete selected permanently",
    detail: "Permanently deletes selected items after a typed confirmation.",
    run: () => deleteSelectedPermanently(app.activePane)
  },
  {
    name: "Open app trash",
    detail: "Browses Explore Better's local trash for restore or permanent delete.",
    run: () => openAppTrashDialog()
  },
  {
    name: "Open Windows Recycle Bin",
    detail: "Browses Windows Recycle Bin items inside Explore Better for restore workflows.",
    run: () => openWindowsRecycleDialog()
  },
  {
    name: "Duplicate tab",
    detail: "Opens the current path in a new tab.",
    run: () => duplicateTab(app.activePane)
  },
  {
    name: "Close tab",
    detail: "Closes the active tab and keeps it available for quick reopen.",
    run: () => closeTab(app.activePane)
  },
  {
    name: "Reopen closed tab",
    detail: "Restores the most recently closed tab.",
    run: () => reopenClosedTab(app.activePane)
  },
  {
    name: "Next tab",
    detail: "Activates the next tab in the active pane.",
    run: () => cyclePaneTab(app.activePane, 1)
  },
  {
    name: "Previous tab",
    detail: "Activates the previous tab in the active pane.",
    run: () => cyclePaneTab(app.activePane, -1)
  },
  {
    name: "Toggle tab lock",
    detail: "Keeps the active tab parked and opens folder navigation in a new tab.",
    run: () => toggleTabLock(app.activePane)
  },
  {
    name: "Cycle pane view",
    detail: "Switches the active pane between details, compact, and tiles.",
    run: () => cycleViewMode(app.activePane)
  },
  {
    name: "Toggle focus workspace",
    detail: "Hides or restores Navigator and Preview so file panes use the full window. F9.",
    run: () => toggleFocusMode()
  },
  {
    name: "Toggle navigator pane",
    detail: "Shows or hides Navigator while preserving Preview and the file-pane layout.",
    run: () => toggleWorkspacePanel("navigator")
  },
  {
    name: "Toggle preview pane",
    detail: "Shows or hides Preview while preserving Navigator and the file-pane layout.",
    run: () => toggleWorkspacePanel("preview")
  },
  {
    name: "Choose details columns",
    detail: "Configures the metadata columns shown in the active details pane.",
    run: () => openColumnsDialog(app.activePane)
  },
  {
    name: "Open folder formats",
    detail: "Saves or applies folder-specific view, sort, label, and column rules.",
    run: () => openFormatsDialog()
  },
  {
    name: "Save current folder format",
    detail: "Captures the active pane view settings for this folder.",
    run: () => saveCurrentFolderFormat()
  },
  {
    name: "Open display presets",
    detail: "Manages reusable pane view recipes that can be applied anywhere.",
    run: () => openDisplayPresetsDialog()
  },
  {
    name: "Save current display preset",
    detail: "Captures the active pane view as a named reusable preset.",
    run: () => quickSaveDisplayPreset()
  },
  {
    name: "Select all visible",
    detail: "Selects every item currently shown in the active pane.",
    run: () => selectAll(app.activePane)
  },
  {
    name: "Advanced select",
    detail: "Selects, adds, removes, or keeps visible items using masks, size, date, and attributes.",
    run: () => openSelectMaskDialog(app.activePane)
  },
  {
    name: "Open selection sets",
    detail: "Saves or restores exact hand-picked selections for busy folders.",
    run: () => openSelectionSetsDialog(app.activePane)
  },
  {
    name: "Save current selection set",
    detail: "Captures the active pane selection as an exact reusable set.",
    run: () => quickSaveSelectionSet(app.activePane)
  },
  {
    name: "Clear selection",
    detail: "Clears the active pane selection.",
    run: () => clearSelection(app.activePane)
  },
  {
    name: "Invert selection",
    detail: "Selects visible unselected items and clears visible selected items.",
    run: () => invertSelection(app.activePane)
  },
  {
    name: "Search active pane",
    detail: "Opens filename and content search for the active pane.",
    run: () => deepSearch(app.activePane)
  },
  {
    name: "Quick search current folder",
    detail: "Opens the inline search bar for instant filtering and match jumping.",
    run: () => openQuickSearch(app.activePane, "filter")
  },
  {
    name: "Flat view active folder",
    detail: "Recursively flattens files or folders from the active pane into a virtual view.",
    run: () => openFlatDialog()
  },
  {
    name: "Find duplicates",
    detail: "Finds same-size or confirmed SHA-256 duplicate files under the active folder.",
    run: () => openDuplicatesDialog()
  },
  {
    name: "Quick edit text file",
    detail: "Opens the selected small text file in the built-in editor with undoable save.",
    run: () => openTextEditor(app.activePane)
  },
  {
    name: "Open viewer",
    detail: "Opens the focused or selected previewable file in the large in-app viewer.",
    run: () => openViewer(app.activePane)
  },
  {
    name: "Show properties",
    detail: "Audits selected items or the active folder with size, counts, and hashes.",
    run: () => openPropertiesDialog(app.activePane)
  },
  {
    name: "Set file attributes",
    detail: "Sets or clears Windows read-only, hidden, system, and archive flags.",
    run: () => openAttributesDialog(app.activePane)
  },
  {
    name: "Set timestamps",
    detail: "Sets selected item modified, created, and accessed times.",
    run: () => openTimestampsDialog(app.activePane)
  },
  {
    name: "Open Windows properties",
    detail: "Opens the native Windows property sheet for the first selected item or active folder.",
    run: () => openWindowsProperties(app.activePane)
  },
  {
    name: "Open shell verbs",
    detail: "Lists native Windows shell verbs for the first selected item or active folder.",
    run: () => openShellVerbsDialog(app.activePane)
  },
  {
    name: "Open shell browser",
    detail: "Browses Windows virtual namespaces such as This PC, Libraries, Network, phones, and devices.",
    run: () => openShellNamespaceDialog("thisPc")
  },
  {
    name: "Calculate folder sizes",
    detail: "Recursively sizes selected folders, or the visible folders when nothing is selected.",
    run: () => calculateFolderSizes(app.activePane)
  },
  {
    name: "Open size analyzer",
    detail: "Scans the active folder into top folders, extensions, files, and a treemap chart.",
    run: () => openSizeAnalysisDialog(app.activePane, "overview")
  },
  {
    name: "Open Disk Map",
    detail: "Opens the hierarchical nested treemap for disk usage analysis.",
    run: () => openSizeAnalysisDialog(app.activePane, "map")
  },
  {
    name: "Compare panes",
    detail: "Compares the left and right pane folders.",
    run: () => openCompareDialog()
  },
  {
    name: "Reveal in Explorer",
    detail: "Asks Windows Explorer to reveal the first selected item.",
    run: () => revealSelected()
  },
  {
    name: "Open with external app",
    detail: "Launches the current selection through default app, terminal, or a custom executable.",
    run: () => openOpenWithDialog(app.activePane)
  },
  {
    name: "Add active path to favorites",
    detail: "Pins the active pane path to the root strip.",
    run: () => addFavorite(app.activePane)
  },
  {
    name: "Open favorites manager",
    detail: "Renames, recolors, reorders, and opens pinned Navigator paths.",
    run: () => openFavoritesDialog()
  },
  {
    name: "Open folder aliases",
    detail: "Manages path-bar aliases like proj: for long folders.",
    run: () => openAliasesDialog()
  },
  {
    name: "Open pane history",
    detail: "Shows back, current, and forward folders for the active pane.",
    run: () => openPaneHistoryDialog(app.activePane)
  },
  {
    name: "Open operation history",
    detail: "Shows queued, completed, failed, and undoable operations.",
    run: () => openOpsDialog()
  },
  {
    name: "Open speed index",
    detail: "Builds and searches the active folder index for instant warm-cache lookups.",
    run: () => openSpeedDialog(app.activePane)
  },
  {
    name: "Open manual",
    detail: "Shows the Explore Better user manual in the built-in viewer.",
    run: () => openManualDialog()
  },
  {
    name: "Open hotkeys",
    detail: "Manages custom keyboard shortcuts for commands, tools, and scripts.",
    run: () => openHotkeysDialog()
  },
  {
    name: "Open configuration backup",
    detail: "Exports or restores a portable Explore Better settings package.",
    run: () => openBackupDialog()
  },
  {
    name: "Open preferences",
    detail: "Adjusts density, preview, refresh, paste, and shell-open defaults.",
    run: () => openPreferencesDialog()
  },
  {
    name: "Customize toolbar",
    detail: "Chooses which built-in buttons stay visible in the command dock.",
    run: () => openToolbarDialog()
  },
  {
    name: "Export configuration backup",
    detail: "Downloads layouts, aliases, labels, tools, scripts, hotkeys, and settings.",
    run: () => exportConfigPackage()
  },
  {
    name: "Import configuration backup",
    detail: "Imports a saved Explore Better configuration package.",
    run: () => openBackupPackageFilePicker()
  },
  {
    name: "Open saved tools",
    detail: "Edits trusted toolbar commands and scripts.",
    run: () => openToolsDialog()
  },
  {
    name: "Export tool package",
    detail: "Downloads saved trusted tools as a portable JSON package.",
    run: () => exportToolPackage()
  },
  {
    name: "Import tool package",
    detail: "Imports saved trusted tools from a JSON package.",
    run: () => openToolPackageFilePicker()
  },
  {
    name: "Open saved layouts",
    detail: "Saves or restores the full dual-pane workspace.",
    run: () => openLayoutsDialog()
  },
  {
    name: "Open tab groups",
    detail: "Saves or restores the active pane's folder tabs.",
    run: () => openTabGroupsDialog()
  },
  {
    name: "Open file collections",
    detail: "Creates and opens virtual collections of paths from anywhere.",
    run: () => openCollectionsDialog()
  },
  {
    name: "Add selection to file basket",
    detail: "Adds selected items to the temporary cross-folder basket.",
    run: () => addSelectionToBasket(app.activePane)
  },
  {
    name: "Open file basket",
    detail: "Shows the temporary basket for copy, move, archive, or virtual pane actions.",
    run: () => openBasketDialog()
  },
  {
    name: "Open basket in active pane",
    detail: "Resolves basket items into a virtual pane view.",
    run: () => openBasketInPane(app.activePane)
  },
  {
    name: "Open pane snapshots",
    detail: "Saves and restores frozen virtual listings from a pane.",
    run: () => openSnapshotsDialog()
  },
  {
    name: "Save pane snapshot",
    detail: "Captures the active pane's current listing and selection.",
    run: () => quickSavePaneSnapshot(app.activePane)
  },
  {
    name: "Add selection to collection",
    detail: "Adds selected items to the active file collection.",
    run: () => addSelectionToCollection()
  },
  {
    name: "Label selected items",
    detail: "Applies persistent local labels and notes to selected paths.",
    run: () => openLabelsDialog(app.activePane)
  },
  {
    name: "Open Explorer integration",
    detail: "Generates or applies current-user shell integration files.",
    run: () => openIntegrationDialog()
  },
  {
    name: "Open script console",
    detail: "Runs trusted JavaScript with file-manager helper APIs.",
    run: () => openScriptDialog()
  },
  {
    name: "Export script package",
    detail: "Downloads saved trusted scripts as a portable JSON package.",
    run: () => exportScriptPackage()
  },
  {
    name: "Import script package",
    detail: "Imports saved trusted scripts from a JSON package.",
    run: () => openScriptPackageFilePicker()
  }
];

function createPaneState() {
  return {
    activeTab: 0,
    tabs: [
      {
        path: "",
        entries: [],
        selected: new Set(),
        history: [],
        future: [],
        filter: "",
        kindFilter: "all",
        labelFilter: "all",
        columns: defaultColumns(),
        columnWidths: {},
        sortKey: "name",
        sortDir: "asc",
        viewMode: "details",
        searchMode: false,
        virtualMode: "",
        virtual: null,
        title: "",
        locked: false,
        parent: null,
        folderSignature: null,
        listingIncludesDimensions: false,
        listingIncludesLinks: false,
        listingIncludesAttributes: false,
        folderWatchVersion: null,
        lastLoadTiming: null,
        listingWindow: null,
        accessError: null,
        redirectedFrom: null,
        visibleEntriesRevision: 0,
        focusedPath: null,
        anchorPath: null
      }
    ]
  };
}

function tabOf(paneName) {
  const pane = panes[paneName];
  return pane.tabs[pane.activeTab];
}

function otherPane(paneName) {
  return paneName === "left" ? "right" : "left";
}

function isPaneName(paneName) {
  return paneName === "left" || paneName === "right";
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function compactPaneActivityCount(value) {
  const count = Math.max(0, Number(value || 0));
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  }
  return String(Math.round(count));
}

function compactPaneActivityDuration(value) {
  const ms = Math.max(0, Number(value || 0));
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function paneActivityMarkup(paneName) {
  const activity = app.paneLoads[paneName] || {};
  const phase = ["idle", "loading", "hydrating", "ready", "error"].includes(activity.phase)
    ? activity.phase
    : "idle";
  return `<span class="pane-status-cluster">
    <span class="pane-activity-badge ${phase}" data-pane-activity="${paneName}" role="status" aria-live="polite" aria-label="${escapeHtml(
      activity.detail || `${paneName} pane ready`
    )}" title="${escapeHtml(activity.detail || "Ready")}">
      <span class="pane-activity-dot" aria-hidden="true"></span>
      <span data-pane-activity-text="${paneName}">${escapeHtml(activity.text || "Ready")}</span>
    </span>
    <span class="pane-role-badge" data-pane-role="${paneName}"></span>
  </span>`;
}

function renderPaneActivity(paneName) {
  const activity = app.paneLoads[paneName];
  const pane = document.querySelector(`.pane[data-pane="${paneName}"]`);
  const badge = document.querySelector(`[data-pane-activity="${paneName}"]`);
  if (!activity || !pane) {
    return;
  }
  const busy = Boolean(activity.controller);
  pane.classList.toggle("is-loading", busy);
  pane.setAttribute("aria-busy", busy ? "true" : "false");
  if (!badge) {
    return;
  }
  badge.className = `pane-activity-badge ${activity.phase || "idle"}`;
  badge.setAttribute("aria-label", activity.detail || `${paneName} pane ready`);
  badge.title = activity.detail || "Ready";
  const text = badge.querySelector(`[data-pane-activity-text="${paneName}"]`);
  if (text) {
    text.textContent = activity.text || "Ready";
  }
}

function setPaneActivity(paneName, load, phase, options = {}) {
  if (load && !isCurrentPaneLoad(paneName, load)) {
    return;
  }
  const state = app.paneLoads[paneName];
  const count = Number(options.count || 0);
  const total = Number(options.total || 0);
  const wallMs = Number(options.wallMs || 0);
  let text = options.text || "Ready";
  if (!options.text && phase === "loading") text = "Loading";
  if (!options.text && phase === "hydrating") {
    text = `${compactPaneActivityCount(count)} / ${compactPaneActivityCount(total)}`;
  }
  if (!options.text && phase === "ready") {
    text = options.cached
      ? `${compactPaneActivityCount(count)} / cached`
      : `${compactPaneActivityCount(count)} / ${compactPaneActivityDuration(wallMs)}`;
  }
  if (!options.text && phase === "error") text = "Error";
  Object.assign(state, {
    phase,
    text,
    detail: options.detail || text,
    count: count || null,
    total: total || null,
    wallMs: wallMs || null
  });
  renderPaneActivity(paneName);
}

function setPaneNavigationStatus(paneName, message) {
  if (app.activePane === paneName) {
    setStatus(message);
  }
}

function beginPaneLoad(paneName, options = {}) {
  const state = app.paneLoads[paneName];
  state.controller?.abort();
  const controller = new AbortController();
  state.id += 1;
  state.controller = controller;
  const load = { id: state.id, controller, startedAt: performance.now() };
  setPaneActivity(paneName, load, "loading", {
    detail: options.detail || `${paneName === "left" ? "Left" : "Right"} pane loading`
  });
  return load;
}

function isCurrentPaneLoad(paneName, load) {
  const state = app.paneLoads[paneName];
  return state?.id === load?.id && state.controller === load?.controller;
}

function finishPaneLoad(paneName, load) {
  if (isCurrentPaneLoad(paneName, load)) {
    app.paneLoads[paneName].controller = null;
    renderPaneActivity(paneName);
  }
}

function paneLoadInFlight(paneName) {
  return Boolean(app.paneLoads[paneName]?.controller);
}

function normalizePaneLayout(layoutMode) {
  return ["vertical", "horizontal", "single"].includes(layoutMode) ? layoutMode : "vertical";
}

function normalizeKindFilter(value) {
  return kindFilterValues.has(value) ? value : "all";
}

function kindFilterLabel(value) {
  const normalized = normalizeKindFilter(value);
  return kindFilterOptions.find((option) => option.value === normalized)?.label || "All";
}

const shellOpenModeLabels = {
  leftReplace: "Replace left pane",
  rightReplace: "Replace right pane",
  activeReplace: "Replace active pane",
  activeNewTab: "New tab in active pane"
};

const launchModeLabels = {
  native: "Native window",
  appWindow: "App window",
  browser: "Browser tab"
};

const conflictModeLabels = {
  unique: "Rename",
  overwrite: "Overwrite",
  skip: "Skip"
};

const densityLabels = {
  compact: "Compact",
  comfortable: "Comfortable",
  spacious: "Spacious"
};

const openGestureLabels = {
  double: "Double-click open",
  single: "Single-click open"
};

const startupModeLabels = {
  last: "Restore last lister",
  homeDownloads: "Home + Downloads",
  workspaceHome: "Workspace + Home",
  documentsDownloads: "Documents + Downloads",
  savedLayout: "Saved layout"
};

const editableAttributeDefinitions = [
  { key: "readonly", label: "Read-only", flag: "R" },
  { key: "hidden", label: "Hidden", flag: "H" },
  { key: "system", label: "System", flag: "S" },
  { key: "archive", label: "Archive", flag: "A" }
];

const editableTimestampDefinitions = [
  { key: "modified", label: "Modified" },
  { key: "created", label: "Created" },
  { key: "accessed", label: "Accessed" }
];

const toolbarActionCatalog = [
  { id: "palette", label: "Command", group: "Core" },
  { id: "manual", label: "Manual", group: "Core" },
  { id: "preferences", label: "Preferences", group: "Core" },
  { id: "toolbar", label: "Toolbar", group: "Core" },
  { id: "commands", label: "Tools", group: "Core" },
  { id: "hotkeys", label: "Hotkeys", group: "Core" },
  { id: "backup", label: "Backup", group: "Core" },
  { id: "integration", label: "Integrate", group: "Core" },
  { id: "clipCut", label: "Cut", group: "File Operations" },
  { id: "clipCopy", label: "Copy", group: "File Operations" },
  { id: "clipPaste", label: "Paste", group: "File Operations" },
  { id: "newFile", label: "New File", group: "File Operations" },
  { id: "shortcut", label: "Shortcut", group: "File Operations" },
  { id: "link", label: "Link", group: "File Operations" },
  { id: "recycle", label: "Recycle", group: "File Operations" },
  { id: "delete", label: "Delete", group: "File Operations" },
  { id: "destination", label: "Send To", group: "File Operations" },
  { id: "transfer", label: "Transfer", group: "File Operations" },
  { id: "archive", label: "Archive", group: "File Operations" },
  { id: "compare", label: "Compare", group: "File Operations" },
  { id: "layouts", label: "Layouts", group: "Organization" },
  { id: "tabGroups", label: "Tab Groups", group: "Organization" },
  { id: "aliases", label: "Aliases", group: "Organization" },
  { id: "collections", label: "Collections", group: "Organization" },
  { id: "basketAdd", label: "Add Basket", group: "Organization" },
  { id: "basket", label: "Basket", group: "Organization" },
  { id: "snapshots", label: "Snapshots", group: "Organization" },
  { id: "labels", label: "Labels", group: "Organization" },
  { id: "filters", label: "Filters", group: "Views" },
  { id: "columns", label: "Columns", group: "Views" },
  { id: "formats", label: "Formats", group: "Views" },
  { id: "presets", label: "Presets", group: "Views" },
  { id: "selectMask", label: "Select", group: "Views" },
  { id: "selectionSets", label: "Sets", group: "Views" },
  { id: "flat", label: "Flat", group: "Views" },
  { id: "duplicates", label: "Dupes", group: "Views" },
  { id: "quickSearch", label: "Quick", group: "Views" },
  { id: "search", label: "Search", group: "Views" },
  { id: "speed", label: "Speed", group: "Views" },
  { id: "viewer", label: "Viewer", group: "Views" },
  { id: "copyNames", label: "Names", group: "Power Tools" },
  { id: "checksums", label: "Hashes", group: "Power Tools" },
  { id: "script", label: "Script", group: "Power Tools" },
  { id: "editText", label: "Edit", group: "Power Tools" },
  { id: "properties", label: "Properties", group: "Power Tools" },
  { id: "attributes", label: "Attributes", group: "Power Tools" },
  { id: "timestamps", label: "Timestamps", group: "Power Tools" },
  { id: "windowsProperties", label: "Win Props", group: "Power Tools" },
  { id: "folderSizes", label: "Sizes", group: "Power Tools" },
  { id: "sizeAnalysis", label: "Analyzer", group: "Power Tools" },
  { id: "bulkRename", label: "Bulk Rename", group: "Power Tools" },
  { id: "openWith", label: "Open With", group: "Power Tools" },
  { id: "reveal", label: "Reveal", group: "Power Tools" },
  { id: "favorite", label: "Favorite", group: "Power Tools" },
  { id: "appTrash", label: "Trash Bin", group: "Power Tools" },
  { id: "ops", label: "Ops", group: "Power Tools" }
];

const toolbarActionIds = toolbarActionCatalog.map((item) => item.id);
const toolbarActionIdSet = new Set(toolbarActionIds);
const toolbarEssentialActions = new Set(["palette", "manual", "preferences", "toolbar"]);
const toolbarPresetDefinitions = [
  {
    id: "everything",
    name: "Everything",
    detail: "Every built-in dock button.",
    actions: toolbarActionIds
  },
  {
    id: "essentials",
    name: "Essentials",
    detail: "Core navigation and file operations.",
    actions: [
      "palette",
      "manual",
      "preferences",
      "toolbar",
      "clipCut",
      "clipCopy",
      "clipPaste",
      "newFile",
      "shortcut",
      "link",
      "destination",
      "recycle",
      "delete",
      "ops"
    ]
  },
  {
    id: "organize",
    name: "Organize",
    detail: "Layouts, labels, baskets, and saved views.",
    actions: [
      "palette",
      "manual",
      "preferences",
      "toolbar",
      "layouts",
      "tabGroups",
      "aliases",
      "collections",
      "basketAdd",
      "basket",
      "snapshots",
      "labels",
      "filters",
      "columns",
      "formats",
      "presets",
      "selectMask",
      "selectionSets"
    ]
  },
  {
    id: "power",
    name: "Power Tools",
    detail: "Search, compare, scripts, hashes, and batch work.",
    actions: [
      "palette",
      "manual",
      "preferences",
      "toolbar",
      "commands",
      "script",
      "speed",
      "search",
      "duplicates",
      "flat",
      "selectionSets",
      "copyNames",
      "checksums",
      "properties",
      "attributes",
      "timestamps",
      "windowsProperties",
      "folderSizes",
      "bulkRename",
      "shortcut",
      "link",
      "archive",
      "compare",
      "destination",
      "transfer",
      "openWith",
      "viewer",
      "ops"
    ]
  }
];

const folderSizeScanLimit = 120;

function normalizeShellOpenMode(value) {
  return Object.prototype.hasOwnProperty.call(shellOpenModeLabels, value)
    ? value
    : "leftReplace";
}

function normalizeLaunchMode(value) {
  return Object.prototype.hasOwnProperty.call(launchModeLabels, value) ? value : "appWindow";
}

function normalizeConflictMode(value) {
  return Object.prototype.hasOwnProperty.call(conflictModeLabels, value) ? value : "unique";
}

function normalizeDensity(value) {
  return Object.prototype.hasOwnProperty.call(densityLabels, value) ? value : "comfortable";
}

function normalizeOpenGesture(value) {
  return Object.prototype.hasOwnProperty.call(openGestureLabels, value) ? value : "double";
}

function normalizeStartupMode(value) {
  return Object.prototype.hasOwnProperty.call(startupModeLabels, value) ? value : "last";
}

function normalizeReferenceId(value) {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function normalizeLayoutSizes(source = {}) {
  const raw = source && typeof source === "object" ? source : {};
  return {
    navWidth: clampNumber(raw.navWidth, 150, 520, layoutSizeDefaults.navWidth),
    inspectorWidth: clampNumber(raw.inspectorWidth, 180, 620, layoutSizeDefaults.inspectorWidth),
    leftPaneWeight: clampNumber(raw.leftPaneWeight, 0.45, 3.5, layoutSizeDefaults.leftPaneWeight),
    rightPaneWeight: clampNumber(raw.rightPaneWeight, 0.45, 3.5, layoutSizeDefaults.rightPaneWeight),
    topPaneWeight: clampNumber(raw.topPaneWeight, 0.45, 3.5, layoutSizeDefaults.topPaneWeight),
    bottomPaneWeight: clampNumber(raw.bottomPaneWeight, 0.45, 3.5, layoutSizeDefaults.bottomPaneWeight),
    dockHeight: clampNumber(raw.dockHeight, 34, 280, layoutSizeDefaults.dockHeight)
  };
}

function normalizeToolbarActions(actions) {
  const clean = [];
  for (const action of Array.isArray(actions) ? actions : []) {
    if (toolbarActionIdSet.has(action) && !clean.includes(action)) {
      clean.push(action);
    }
  }
  return clean;
}

function normalizeToolbarOrder(actions) {
  const clean = [];
  for (const action of Array.isArray(actions) ? actions : []) {
    if (toolbarActionIdSet.has(action) && !clean.includes(action)) {
      clean.push(action);
    }
  }
  return clean;
}

function paneLayoutLabel(layoutMode = app.paneLayout) {
  if (layoutMode === "horizontal") {
    return "Horizontal split";
  }
  if (layoutMode === "single") {
    return "Single pane";
  }
  return "Vertical split";
}

async function request(url, options = {}) {
  const { invalidateListingCache, ...fetchOptions } = options;
  const method = String(options.method || "GET").toUpperCase();
  const pathname = new URL(url, window.location.href).pathname;
  const shouldWatchOperation =
    method !== "GET" &&
    pathname !== "/api/state" &&
    pathname !== "/api/operations/clear" &&
    !operationPreviewRoutes.has(pathname);
  if (shouldWatchOperation && app.state) {
    scheduleOperationPoll(200);
  }
  const response = await fetch(url, {
    ...fetchOptions,
    headers: {
      "content-type": "application/json",
      ...(fetchOptions.headers || {})
    }
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  const data = expandCompactDirectoryListing(parsed);
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  if (shouldInvalidateListingCache(method, pathname, invalidateListingCache)) {
    clearListingCache();
  }
  if (shouldWatchOperation && app.state) {
    scheduleOperationPoll(200);
  }
  return data;
}

function attributesFromCompactText(value) {
  const text = String(value || "").toUpperCase();
  return {
    readonly: text.includes("R"),
    hidden: text.includes("H"),
    system: text.includes("S"),
    archive: text.includes("A"),
    reparse: text.includes("L"),
    compressed: text.includes("C"),
    encrypted: text.includes("E"),
    indexed: text.includes("I"),
    flags: text,
    text
  };
}

function expandCompactDirectoryListing(data) {
  if (!["compact-v1", "compact-v2"].includes(data?.entryFormat) || !Array.isArray(data.entryRows)) {
    return data;
  }
  const parent = String(data.path || "");
  const separator = pathSeparatorFor(parent);
  const isV2 = data.entryFormat === "compact-v2";
  const dictionaries = data.entryDictionaries || {};
  const dictionaryValue = (key, index, fallback = "") =>
    isV2 ? String(dictionaries[key]?.[Number(index)] ?? fallback) : String(index ?? fallback);
  const entries = data.entryRows.map((row) => {
    const flags = Number(row?.[1] || 0);
    const attributeText = dictionaryValue("attributes", row?.[8], "");
    const attributes = attributesFromCompactText(attributeText);
    return {
      name: String(row?.[0] || ""),
      path: joinPathSegment(parent, String(row?.[0] || ""), separator),
      parent,
      isDirectory: (flags & 1) !== 0,
      isFile: (flags & 2) !== 0,
      readonly: (flags & 4) !== 0,
      hidden: (flags & 8) !== 0,
      system: (flags & 16) !== 0,
      archive: (flags & 32) !== 0,
      isSymlink: (flags & 64) !== 0,
      unavailable: (flags & 128) !== 0,
      extension: dictionaryValue("extensions", row?.[2], ""),
      kind: dictionaryValue("kinds", row?.[3], "File"),
      size: row?.[4] ?? null,
      modified: row?.[5] ?? null,
      created: row?.[6] ?? null,
      accessed: row?.[7] ?? null,
      attributes,
      attributeText,
      label: row?.[9] || undefined,
      dimensions: null,
      dimensionText: String(row?.[10] || ""),
      dimensionPixels: row?.[11] ?? null,
      linkType: dictionaryValue("linkTypes", row?.[12], ""),
      linkTarget: String(row?.[13] || ""),
      linkTargetRaw: String(row?.[14] || ""),
      linkCount: row?.[15] ?? null,
      mode: row?.[16] ?? null
    };
  });
  const { entryRows, entryDictionaries, ...metadata } = data;
  return { ...metadata, entries };
}

function normalizeSavedTab(savedTab, fallbackPath) {
  return {
    path: savedTab?.path || fallbackPath || "",
    entries: [],
    selected: new Set(),
    history: Array.isArray(savedTab?.history) ? savedTab.history : [],
    future: Array.isArray(savedTab?.future) ? savedTab.future : [],
    filter: savedTab?.filter || "",
    kindFilter: normalizeKindFilter(savedTab?.kindFilter),
    labelFilter: savedTab?.labelFilter || "all",
    columns: normalizeColumns(savedTab?.columns),
    columnWidths: normalizeColumnWidths(savedTab?.columnWidths),
    sortKey: savedTab?.sortKey || "name",
    sortDir: savedTab?.sortDir === "desc" ? "desc" : "asc",
    viewMode: ["details", "compact", "tiles"].includes(savedTab?.viewMode)
      ? savedTab.viewMode
      : "details",
    searchMode: false,
    virtualMode: "",
    virtual: null,
    title: savedTab?.title || "",
    locked: savedTab?.locked === true,
    parent: savedTab?.parent || null,
    folderSignature: null,
    listingIncludesDimensions: false,
    listingIncludesLinks: false,
    listingIncludesAttributes: false,
    folderWatchVersion: null,
    lastLoadTiming: null,
    listingWindow: null,
    visibleEntriesRevision: 0,
    focusedPath: null,
    anchorPath: null
  };
}

function serializePaneTabs(paneName) {
  const pane = panes[paneName];
  return {
    activeTab: pane.activeTab,
    tabs: pane.tabs.map((tab) => ({
      path: tab.path,
      title: tab.title,
      parent: tab.parent,
      history: tab.history.slice(-20),
      future: tab.future.slice(-20),
      filter: tab.filter,
      kindFilter: normalizeKindFilter(tab.kindFilter),
      labelFilter: tab.labelFilter || "all",
      columns: normalizeColumns(tab.columns),
      columnWidths: normalizeColumnWidths(tab.columnWidths),
      sortKey: tab.sortKey,
      sortDir: tab.sortDir,
      viewMode: tab.viewMode,
      locked: tab.locked === true
    }))
  };
}

function serializeLayout() {
  return {
    activePane: app.activePane,
    paneLayout: normalizePaneLayout(app.paneLayout),
    panes: {
      left: serializePaneTabs("left"),
      right: serializePaneTabs("right")
    }
  };
}

function shellOpenPaneName(mode) {
  if (mode === "rightReplace") {
    return "right";
  }
  if (mode === "activeReplace" || mode === "activeNewTab") {
    return isPaneName(app.activePane) ? app.activePane : "left";
  }
  return "left";
}

function shellTabForPath(targetPath, baseTab = {}) {
  return normalizeSavedTab(
    {
      ...baseTab,
      path: targetPath,
      history: [],
      future: [],
      filter: "",
      kindFilter: "all",
      searchMode: false,
      locked: false,
      title: "",
      parent: null
    },
    targetPath
  );
}

function applyShellOpenParams(urlParams) {
  const targetPath = urlParams.get("open") || urlParams.get("shellPath");
  if (!targetPath) {
    return null;
  }
  const mode = normalizeShellOpenMode(
    urlParams.get("shellMode") || app.state?.settings?.shellOpenMode
  );
  const paneName = shellOpenPaneName(mode);
  const pane = panes[paneName];
  const currentTab = pane.tabs[pane.activeTab] || {};
  app.activePane = paneName;
  if (mode === "activeNewTab") {
    pane.tabs.push(shellTabForPath(targetPath, currentTab));
    pane.activeTab = pane.tabs.length - 1;
  } else {
    pane.tabs[pane.activeTab] = shellTabForPath(targetPath, currentTab);
  }
  return { paneName, mode, targetPath };
}

function hasExplicitStartupTarget(urlParams = new URLSearchParams()) {
  return (
    urlParams.has("left") ||
    urlParams.has("right") ||
    urlParams.has("open") ||
    urlParams.has("shellPath")
  );
}

function rootShortcutPath(kind, fallback) {
  return app.roots?.shortcuts?.find((item) => item.kind === kind)?.path || fallback;
}

function startupPairForMode(mode = currentSettings().startupMode) {
  const home = app.roots?.home || rootShortcutPath("home", app.roots?.cwd);
  const workspace = rootShortcutPath("workspace", app.roots?.cwd || home);
  const downloads = rootShortcutPath("downloads", home);
  const documents = rootShortcutPath("documents", home);
  switch (normalizeStartupMode(mode)) {
    case "homeDownloads":
      return { left: home, right: downloads };
    case "workspaceHome":
      return { left: workspace, right: home };
    case "documentsDownloads":
      return { left: documents, right: downloads };
    default:
      return null;
  }
}

function savedStartupLayout(layoutId = currentSettings().startupLayoutId) {
  const targetId = normalizeReferenceId(layoutId);
  return (app.state?.layouts || []).find((layout) => layout.id === targetId) || null;
}

function startupSettingLabel(settings = currentSettings()) {
  if (normalizeStartupMode(settings.startupMode) === "savedLayout") {
    const layout = savedStartupLayout(settings.startupLayoutId);
    return layout ? `Layout: ${layout.name}` : "Saved layout missing";
  }
  return startupModeLabels[normalizeStartupMode(settings.startupMode)];
}

function startupLayoutForMode(mode, settings = currentSettings()) {
  if (normalizeStartupMode(mode) === "savedLayout") {
    return savedStartupLayout(settings.startupLayoutId)?.layout || null;
  }
  const pair = startupPairForMode(mode);
  if (!pair) {
    return null;
  }
  return {
    activePane: "left",
    paneLayout: "vertical",
    panes: {
      left: { activeTab: 0, tabs: [{ path: pair.left }] },
      right: { activeTab: 0, tabs: [{ path: pair.right }] }
    }
  };
}

function hydratePanesFromLayout(layout, urlParams = new URLSearchParams()) {
  const savedLayout = layout || {};
  app.paneLayout = normalizePaneLayout(
    savedLayout.paneLayout || savedLayout.layoutMode || savedLayout.mode
  );
  const explicitLeftPath = urlParams.has("left");
  const explicitRightPath = urlParams.has("right");
  const leftPath = urlParams.get("left") || savedLayout.panes?.left?.tabs?.[0]?.path || app.roots.cwd;
  const rightPath = urlParams.get("right") || savedLayout.panes?.right?.tabs?.[0]?.path || app.roots.home;

  for (const paneName of ["left", "right"]) {
    const savedPane = savedLayout.panes?.[paneName] || {};
    const fallbackPath = paneName === "left" ? leftPath : rightPath;
    const hasExplicitPath = paneName === "left" ? explicitLeftPath : explicitRightPath;
    const savedTabs = Array.isArray(savedPane.tabs) && savedPane.tabs.length
      ? savedPane.tabs
      : [{ path: fallbackPath }];
    panes[paneName].tabs = savedTabs.map((tab, index) =>
      normalizeSavedTab(index === 0 ? { ...tab, path: fallbackPath } : tab, fallbackPath)
    );
    panes[paneName].activeTab = hasExplicitPath
      ? 0
      : Math.max(0, Math.min(Number(savedPane.activeTab || 0), panes[paneName].tabs.length - 1));
  }

  app.activePane = savedLayout.activePane === "right" ? "right" : "left";
  applyShellOpenParams(urlParams);
  renderLayoutChrome();
}

function hydratePanesFromState(urlParams) {
  const settings = currentSettings();
  const startupLayout = hasExplicitStartupTarget(urlParams)
    ? null
    : startupLayoutForMode(settings.startupMode, settings);
  hydratePanesFromLayout(startupLayout || app.state?.layout || {}, urlParams);
}

function startupPaneHasExplicitTarget(paneName, urlParams) {
  if (urlParams.has(paneName)) {
    return true;
  }
  if (!urlParams.has("open") && !urlParams.has("shellPath")) {
    return false;
  }
  const mode = normalizeShellOpenMode(urlParams.get("shellMode") || app.state?.settings?.shellOpenMode);
  return shellOpenPaneName(mode) === paneName;
}

function missingStartupPathError(error) {
  return /\bENOENT\b|\bENOTDIR\b|no such file or directory|cannot find the path|path was not found/i.test(
    String(error?.message || error || "")
  );
}

function startupRecoveryCandidates(targetPath, fallbackPath) {
  const candidates = [];
  const seen = new Set([normalizedPathKey(targetPath)]);
  const add = (candidate) => {
    const value = String(candidate || "").trim();
    const key = normalizedPathKey(value);
    if (!value || !key || seen.has(key)) return;
    seen.add(key);
    candidates.push(value);
  };
  let current = parseZipVirtualPath(targetPath)?.archivePath || String(targetPath || "");
  for (let depth = 0; depth < 32; depth += 1) {
    let parent = parentPathOf(current);
    if (/^[a-z]:$/i.test(parent)) {
      parent += "\\";
    }
    if (!parent || samePath(parent, current)) break;
    add(parent);
    current = parent;
  }
  add(fallbackPath);
  add(rootShortcutPath("workspace", app.roots?.cwd));
  add(app.roots?.home);
  add(app.roots?.cwd);
  return candidates;
}

async function loadStartupPane(paneName, targetPath, fallbackPath, { allowRecovery = true } = {}) {
  try {
    await loadPane(paneName, targetPath, false, { linkedFollow: true });
    return { recovered: false, path: tabOf(paneName).path };
  } catch (error) {
    if (!allowRecovery || !missingStartupPathError(error)) {
      throw error;
    }
    for (const candidate of startupRecoveryCandidates(targetPath, fallbackPath)) {
      try {
        await loadPane(paneName, candidate, false, {
          linkedFollow: true,
          silent: true,
          save: false,
          preserveSelection: false
        });
        showToast(`${paneName === "left" ? "Left" : "Right"} pane recovered to ${candidate}`);
        return { recovered: true, path: candidate, missingPath: targetPath };
      } catch (candidateError) {
        if (!missingStartupPathError(candidateError)) {
          throw candidateError;
        }
      }
    }
    throw error;
  }
}

function operationSummary() {
  const operations = app.state?.operations || [];
  const active = operations.filter(operationIsActive);
  if (active.length) {
    const running = active.filter((item) => item.status === "running").length;
    const paused = active.filter((item) => item.status === "paused").length;
    const queued = active.filter((item) => item.status === "queued").length;
    const parts = [
      running ? `${running} running` : "",
      paused ? `${paused} paused` : "",
      queued ? `${queued} queued` : ""
    ].filter(Boolean);
    if (parts.length > 1) {
      return parts.join(" / ");
    }
    return parts[0];
  }
  if (operations[0]?.status === "failed") {
    return "last failed";
  }
  return `${operations.length} ops`;
}

async function loadState() {
  app.state = await request("/api/state");
  updateOperationReadout();
  return app.state;
}

async function loadIntegrationStatus() {
  app.integrationStatus = await request("/api/integration/status");
  return app.integrationStatus;
}

async function saveStateNow() {
  if (!app.state) {
    return null;
  }
  app.state.layout = serializeLayout();
  app.state = await request("/api/state", {
    method: "POST",
    body: JSON.stringify({
      layout: app.state.layout,
      favorites: app.state.favorites || [],
      aliases: app.state.aliases || [],
      recentLocations: app.state.recentLocations || [],
      fileBasket: app.state.fileBasket || [],
      layouts: app.state.layouts || [],
      tabGroups: app.state.tabGroups || [],
      collections: app.state.collections || [],
      paneSnapshots: app.state.paneSnapshots || [],
      selectionSets: app.state.selectionSets || [],
      labels: app.state.labels || [],
      folderFormats: app.state.folderFormats || [],
      displayPresets: app.state.displayPresets || [],
      filterPresets: app.state.filterPresets || [],
      syncProfiles: app.state.syncProfiles || [],
      openWithPresets: app.state.openWithPresets || [],
      searchPresets: app.state.searchPresets || [],
      selectPresets: app.state.selectPresets || [],
      bulkRenamePresets: app.state.bulkRenamePresets || [],
      scripts: app.state.scripts || [],
      commands: app.state.commands || [],
      settings: app.state.settings || {}
    })
  });
  updateOperationReadout();
  return app.state;
}

function scheduleStateSave() {
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(() => {
    saveStateNow().catch((error) => showToast(error.message));
  }, 250);
}

function setStatus(message) {
  document.getElementById("status-pill").textContent = message;
}

function listingTimingText(data) {
  const totalMs = Number(data?.timing?.totalMs || 0);
  return totalMs > 0 ? ` / load ${Math.round(totalMs)}ms` : "";
}

function paneListingTiming(data, context = {}) {
  const timing = data?.timing ? { ...data.timing } : {};
  const hasTiming = Object.keys(timing).length > 0;
  if (!hasTiming && !context.cached) {
    return null;
  }
  return {
    ...timing,
    cached: context.cached === true,
    source: context.cached ? "memory-cache" : context.source || "filesystem",
    recordedAt: new Date().toISOString()
  };
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function labelForPath(itemPath) {
  if (!itemPath) {
    return "New";
  }
  const zipTarget = parseZipVirtualPath(itemPath);
  if (zipTarget) {
    const archiveLabel = labelForPath(zipTarget.archivePath);
    const innerLabel = zipTarget.innerPath.split("/").filter(Boolean).at(-1);
    return innerLabel ? `${archiveLabel}/${innerLabel}` : archiveLabel;
  }
  const normalized = itemPath.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || itemPath;
}

function formatSize(size) {
  if (size === null || size === undefined) {
    return "";
  }
  if (!Number.isFinite(Number(size))) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(size);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function entrySizeText(entry) {
  if (entry?.isDirectory) {
    if (entry.folderSizeStatus === "scanning") {
      return "Sizing...";
    }
    if (entry.folderSizeStatus === "error") {
      return "Error";
    }
    if (!entry.folderSizeKnown) {
      return "";
    }
  }
  return formatSize(entry?.size);
}

function folderCountSummary(entry) {
  if (!entry?.isDirectory || !entry.folderSizeKnown) {
    return "";
  }
  const parts = [
    itemWord(Number(entry.fileCount || 0), "file"),
    itemWord(Number(entry.folderCount || 0), "folder")
  ];
  if (entry.folderSizeStatus === "partial") {
    parts.push("partial");
  }
  return parts.join(" / ");
}

function entrySizeTitle(entry) {
  if (!entry?.isDirectory) {
    return entrySizeText(entry);
  }
  if (entry.folderSizeStatus === "scanning") {
    return "Recursive folder size scan in progress";
  }
  if (entry.folderSizeStatus === "error") {
    return entry.folderSizeError || "Folder size unavailable";
  }
  if (!entry.folderSizeKnown) {
    return "Folder size not scanned";
  }
  return [entrySizeText(entry), folderCountSummary(entry)].filter(Boolean).join(" / ");
}

function entrySizeClass(entry) {
  if (!entry?.isDirectory) {
    return "";
  }
  if (entry.folderSizeStatus === "scanning") {
    return " scanning";
  }
  if (entry.folderSizeStatus === "error") {
    return " error";
  }
  if (entry.folderSizeKnown) {
    return entry.folderSizeStatus === "partial" ? " known partial" : " known";
  }
  return " unknown";
}

function attributeText(entry) {
  return entry?.attributeText || entry?.attributes?.text || "";
}

function attributeTitle(entry) {
  const attrs = entry?.attributes || {};
  const labels = [
    attrs.readonly || entry?.readonly ? "Read-only" : "",
    attrs.hidden || entry?.hidden ? "Hidden" : "",
    attrs.system || entry?.system ? "System" : "",
    attrs.archive || entry?.archive ? "Archive" : "",
    attrs.reparse ? "Reparse point" : "",
    attrs.compressed ? "Compressed" : "",
    attrs.encrypted ? "Encrypted" : "",
    attrs.indexed ? "Not indexed" : ""
  ].filter(Boolean);
  return labels.length ? labels.join(" / ") : "No file attributes";
}

function linkTypeText(entry) {
  const type = String(entry?.linkType || "").trim();
  const count = Number(entry?.linkCount || 0);
  if (type === "Hard Link" && count > 1) {
    return `Hard Link x${count}`;
  }
  return type;
}

function linkTargetText(entry) {
  return String(entry?.linkTarget || entry?.linkTargetRaw || "").trim();
}

function linkTitle(entry) {
  const type = linkTypeText(entry);
  const target = linkTargetText(entry);
  if (type && target) {
    return `${type} to ${target}`;
  }
  if (type) {
    return type;
  }
  return "No filesystem link";
}

function entryMetaText(entry) {
  const parts = [entry.kind || (entry.isDirectory ? "Folder" : "File")];
  const dimensionsText = imageDimensionsText(entry);
  if (dimensionsText) {
    parts.push(dimensionsText);
  }
  const linkText = linkTypeText(entry);
  if (linkText) {
    parts.push(linkText);
  }
  const sizeText = entrySizeText(entry);
  if (sizeText) {
    parts.push(sizeText);
  }
  const attrs = attributeText(entry);
  if (attrs) {
    parts.push(attrs);
  }
  const countText = folderCountSummary(entry);
  if (countText) {
    parts.push(countText);
  }
  return parts.filter(Boolean).join(" / ");
}

function imageDimensionsText(entry) {
  const width = Number(entry?.dimensions?.width || entry?.width || 0);
  const height = Number(entry?.dimensions?.height || entry?.height || 0);
  if (width > 0 && height > 0) {
    return `${Math.round(width)}x${Math.round(height)}`;
  }
  return entry?.dimensionText || "";
}

function imageDimensionsTitle(entry) {
  const text = imageDimensionsText(entry);
  if (!text) {
    return "";
  }
  const pixels = Number(entry?.dimensionPixels || entry?.dimensions?.pixels || 0);
  return pixels > 0 ? `${text} / ${pixels.toLocaleString()} pixels` : text;
}

function formatDate(value) {
  if (!value) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatMilliseconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "";
  }
  return `${Math.round(Math.max(0, numeric))}ms`;
}

function glyphFor(entry) {
  if (entry.isDirectory) {
    return { text: "DIR", className: "folder" };
  }
  const kind = String(entry.kind || "").toLowerCase();
  if (kind === "image") {
    return { text: "IMG", className: "image" };
  }
  if (kind === "text") {
    return { text: "TXT", className: "text" };
  }
  if (kind === "audio") {
    return { text: "AUD", className: "audio" };
  }
  if (kind === "video") {
    return { text: "VID", className: "video" };
  }
  if (kind === "document") {
    return { text: "DOC", className: "document" };
  }
  if (kind === "archive") {
    return { text: "ZIP", className: "archive" };
  }
  const ext = (entry.extension || "").replace(".", "").slice(0, 3).toUpperCase();
  return { text: ext || "FIL", className: "" };
}

function rawFileUrl(entry) {
  const query = new URLSearchParams({ path: entry.path });
  const size = Number(entry.size || 0);
  const modified = Math.round(Number(entry.modified || 0));
  if (size > 0 || modified > 0) {
    query.set("v", `${size}-${modified}`);
  }
  return `/api/raw?${query.toString()}`;
}

function entryMatchesKindFilter(entry, kindFilter) {
  const filter = normalizeKindFilter(kindFilter);
  if (filter === "all") {
    return true;
  }
  if (filter === "folders") {
    return Boolean(entry.isDirectory);
  }
  if (filter === "files") {
    return Boolean(entry.isFile);
  }
  const kind = String(entry.kind || "").toLowerCase();
  if (filter === "images") {
    return kind === "image";
  }
  if (filter === "text") {
    return kind === "text";
  }
  if (filter === "documents") {
    return kind === "document";
  }
  if (filter === "media") {
    return kind === "audio" || kind === "video";
  }
  if (filter === "archives") {
    return kind === "archive";
  }
  if (filter === "apps") {
    return kind === "application";
  }
  return true;
}

function renderKindFilterOptions(selectedValue = "all") {
  const selected = normalizeKindFilter(selectedValue);
  return kindFilterOptions
    .map(
      (option) =>
        `<option value="${escapeHtml(option.value)}" ${option.value === selected ? "selected" : ""}>${escapeHtml(
          option.label
        )}</option>`
    )
    .join("");
}

function sortedEntries(tab) {
  const filter = tab.filter.trim().toLowerCase();
  const kindFilter = normalizeKindFilter(tab.kindFilter);
  const labelFilter = tab.labelFilter || "all";
  const entries = tab.entries.filter((entry) => {
    const label = entry.label || {};
    const matchesText = filter
      ? `${entry.name} ${entry.kind} ${entry.parent || ""} ${attributeText(entry)} ${linkTypeText(entry)} ${linkTargetText(
          entry
        )} ${imageDimensionsText(entry)} ${label.name || ""} ${label.notes || ""}`
          .toLowerCase()
          .includes(filter)
      : true;
    const matchesLabel =
      labelFilter === "all" ||
      (labelFilter === "any" && entry.label) ||
      (entry.label && entry.label.color === labelFilter);
    return matchesText && matchesLabel && entryMatchesKindFilter(entry, kindFilter);
  });

  const factor = tab.sortDir === "asc" ? 1 : -1;
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory && tab.sortKey === "name") {
      return a.isDirectory ? -1 : 1;
    }
    const left = sortableValue(a, tab.sortKey);
    const right = sortableValue(b, tab.sortKey);
    if (["size", "dimensions", "modified", "created", "accessed"].includes(tab.sortKey)) {
      return ((left || 0) - (right || 0)) * factor;
    }
    return paneValueCollator.compare(String(left), String(right)) * factor;
  });
}

function visibleEntrySignature(tab) {
  return {
    entries: tab.entries,
    length: tab.entries.length,
    filter: tab.filter || "",
    kindFilter: normalizeKindFilter(tab.kindFilter),
    labelFilter: tab.labelFilter || "all",
    sortKey: tab.sortKey || "name",
    sortDir: tab.sortDir === "desc" ? "desc" : "asc",
    revision: Number(tab.visibleEntriesRevision || 0)
  };
}

function sameVisibleEntrySignature(left, right) {
  return Boolean(
    left &&
      right &&
      left.entries === right.entries &&
      left.length === right.length &&
      left.filter === right.filter &&
      left.kindFilter === right.kindFilter &&
      left.labelFilter === right.labelFilter &&
      left.sortKey === right.sortKey &&
      left.sortDir === right.sortDir &&
      left.revision === right.revision
  );
}

function cacheVisibleEntryData(tab, signature, entries) {
  const indexByKey = new Map();
  const pathSet = new Set();
  entries.forEach((entry, index) => {
    const key = normalizedPathKey(entry.path);
    indexByKey.set(key, index);
    pathSet.add(entry.path);
  });
  const data = { signature, entries, indexByKey, pathSet };
  app.visibleEntryCache.set(tab, data);
  let shared = app.sharedVisibleEntryCache.get(signature.entries);
  if (!shared) {
    shared = new Map();
    app.sharedVisibleEntryCache.set(signature.entries, shared);
  }
  shared.set(sharedVisibleEntrySignatureKey(signature), data);
  app.visibleEntryIndexes.set(entries, indexByKey);
  app.visibleEntryPathSets.set(entries, pathSet);
  return data;
}

function sharedVisibleEntrySignatureKey(signature) {
  return [
    signature.length,
    signature.filter,
    signature.kindFilter,
    signature.labelFilter,
    signature.sortKey,
    signature.sortDir,
    signature.revision
  ].join("\u001f");
}

function visibleEntryData(tab) {
  const signature = visibleEntrySignature(tab);
  const cached = app.visibleEntryCache.get(tab);
  if (sameVisibleEntrySignature(cached?.signature, signature)) {
    return cached;
  }
  const shared = app.sharedVisibleEntryCache.get(signature.entries)?.get(sharedVisibleEntrySignatureKey(signature));
  if (shared) {
    app.visibleEntryCache.set(tab, shared);
    return shared;
  }
  return cacheVisibleEntryData(tab, signature, sortedEntries(tab));
}

function invalidateVisibleEntryCache(tab) {
  if (!tab) {
    return;
  }
  tab.visibleEntriesRevision = Number(tab.visibleEntriesRevision || 0) + 1;
  app.visibleEntryCache.delete(tab);
}

function listingCacheKey(
  targetPath,
  showHidden,
  includeDimensions = false,
  includeLinks = false,
  includeAttributes = false
) {
  const key = normalizedPathKey(targetPath) || String(targetPath || "");
  return `${showHidden ? "hidden" : "visible"}:${includeDimensions ? "dim" : "fast"}:${
    includeLinks ? "links" : "nolinks"
  }:${includeAttributes ? "attrs" : "noattrs"}:${key}`;
}

function listingFetchPlan(tab, targetPath, options = {}) {
  const showHidden = showHiddenEntriesEnabled();
  const includeDimensions = listingNeedsDimensions(tab, targetPath);
  const includeLinks = listingNeedsLinks(tab, targetPath);
  const includeAttributes = listingNeedsAttributes(tab, targetPath, showHidden);
  const cacheKey = listingCacheKey(
    targetPath,
    showHidden,
    includeDimensions,
    includeLinks,
    includeAttributes
  );
  const query = new URLSearchParams({
    path: targetPath,
    showHidden: showHidden ? "true" : "false",
    includeDimensions: includeDimensions ? "true" : "false",
    includeLinks: includeLinks ? "true" : "false",
    includeAttributes: includeAttributes ? "true" : "false",
    includeSignature: options.includeSignature ? "true" : "false"
  });
  return {
    showHidden,
    includeDimensions,
    includeLinks,
    includeAttributes,
    cacheKey,
    query
  };
}

function isWindowedListing(data) {
  return Boolean(
    data?.window &&
      (data.window.hasMore === true || Number(data.window.total || 0) > Number(data.entries?.length || 0))
  );
}

function listingWindowStatus(data) {
  const returned = Number(data?.window?.returned ?? data?.entries?.length ?? 0);
  const totalKnown = data?.window?.totalKnown !== false && Number.isFinite(Number(data?.window?.total));
  if (!totalKnown) {
    return `${returned.toLocaleString()}+ items`;
  }
  const total = Number(data?.window?.total ?? returned);
  return `${returned.toLocaleString()}/${total.toLocaleString()} items`;
}

function windowedListingQuery(query, limit = listingWindowInitialLimit) {
  const next = new URLSearchParams(query);
  next.set("offset", "0");
  next.set("limit", String(limit));
  return next;
}

function zipListingFetchPlan(archivePath, innerPath = "") {
  const cleanInnerPath = normalizeZipInnerPath(innerPath);
  const cacheKey = `zip:${normalizedPathKey(archivePath)}:${cleanInnerPath}:${zipPaneEntryLimit}`;
  const query = new URLSearchParams({
    path: archivePath,
    innerPath: cleanInnerPath,
    limit: String(zipPaneEntryLimit)
  });
  return { archivePath, innerPath: cleanInnerPath, cacheKey, query };
}

function shouldInvalidateListingCache(method, pathname, override = undefined) {
  if (override === true) {
    return true;
  }
  if (override === false) {
    return false;
  }
  return method !== "GET" && listingCacheInvalidatingRoutes.has(pathname);
}

function cancelListingPrefetch(cacheKey = null) {
  const prefetch = app.listingPrefetch;
  if (!prefetch) {
    return;
  }
  if (cacheKey) {
    prefetch.queue = prefetch.queue.filter((item) => item.cacheKey !== cacheKey);
    prefetch.queued.delete(cacheKey);
    const active = prefetch.active.get(cacheKey);
    active?.controller?.abort();
    prefetch.active.delete(cacheKey);
    return;
  }
  prefetch.queue = [];
  prefetch.queued.clear();
  for (const active of prefetch.active.values()) {
    active.controller?.abort();
  }
  prefetch.active.clear();
}

function clearListingCache() {
  app.listingCacheGeneration += 1;
  app.listingCache.clear();
  cancelListingPrefetch();
}

function pruneListingCache() {
  while (app.listingCache.size > listingCacheMaxEntries) {
    const oldest = app.listingCache.keys().next().value;
    if (!oldest) {
      return;
    }
    app.listingCache.delete(oldest);
  }
}

function rememberListingCache(cacheKey, data) {
  app.listingCache.delete(cacheKey);
  app.listingCache.set(cacheKey, {
    cachedAt: Date.now(),
    data
  });
  pruneListingCache();
}

function requestFullListingHydration(cacheKey, query) {
  const key = `${app.listingCacheGeneration}:${cacheKey}`;
  const existing = app.listingHydrations.get(key);
  if (existing) {
    return existing;
  }
  const promise = request(`/api/list?${query}`, { invalidateListingCache: false }).finally(() => {
    if (app.listingHydrations.get(key) === promise) {
      app.listingHydrations.delete(key);
    }
  });
  app.listingHydrations.set(key, promise);
  return promise;
}

function listingCacheEntry(cacheKey) {
  const cached = app.listingCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.cachedAt > listingCacheTtlMs) {
    app.listingCache.delete(cacheKey);
    return null;
  }
  return cached;
}

function listingCacheIsFresh(cacheKey) {
  return Boolean(listingCacheEntry(cacheKey));
}

function cachedListing(cacheKey) {
  const cached = listingCacheEntry(cacheKey);
  if (!cached) {
    return null;
  }
  app.listingCache.delete(cacheKey);
  app.listingCache.set(cacheKey, cached);
  return cached.data;
}

function requestIdle(callback, timeout = 500) {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(callback, { timeout });
    return;
  }
  setTimeout(callback, 0);
}

function runListingPrefetchQueue() {
  const prefetch = app.listingPrefetch;
  while (prefetch.active.size < listingPrefetchMaxActive && prefetch.queue.length) {
    const item = prefetch.queue.shift();
    prefetch.queued.delete(item.cacheKey);
    if (listingCacheIsFresh(item.cacheKey)) {
      continue;
    }
    const controller = new AbortController();
    prefetch.active.set(item.cacheKey, { controller });
    request(`/api/list?${item.query}`, {
      signal: controller.signal,
      invalidateListingCache: false
    })
      .then((data) => {
        if (
          !controller.signal.aborted &&
          item.generation === app.listingCacheGeneration
        ) {
          rememberListingCache(item.cacheKey, data);
        }
      })
      .catch((error) => {
        if (!isAbortError(error)) {
          console.debug("Listing prefetch skipped", error);
        }
      })
      .finally(() => {
        prefetch.active.delete(item.cacheKey);
        runListingPrefetchQueue();
      });
  }
}

function queueListingPrefetch(paneName, targetPath, reason = "intent") {
  if (!isPaneName(paneName) || !targetPath || document.hidden || paneLoadInFlight(paneName)) {
    return false;
  }
  const tab = tabOf(paneName);
  if (tab.searchMode || samePath(targetPath, tab.path)) {
    return false;
  }
  const plan = listingFetchPlan(tab, expandAliasPath(targetPath), { includeSignature: false });
  if (
    listingCacheIsFresh(plan.cacheKey) ||
    app.listingPrefetch.queued.has(plan.cacheKey) ||
    app.listingPrefetch.active.has(plan.cacheKey)
  ) {
    return false;
  }
  app.listingPrefetch.queue.push({
    paneName,
    targetPath: expandAliasPath(targetPath),
    cacheKey: plan.cacheKey,
    query: plan.query,
    reason,
    generation: app.listingCacheGeneration
  });
  app.listingPrefetch.queued.add(plan.cacheKey);
  while (app.listingPrefetch.queue.length > listingPrefetchMaxQueue) {
    const dropped = app.listingPrefetch.queue.shift();
    app.listingPrefetch.queued.delete(dropped.cacheKey);
  }
  setTimeout(() => requestIdle(runListingPrefetchQueue, 650), listingPrefetchDelayMs);
  return true;
}

function prefetchEntryListing(paneName, entryPath, reason = "intent") {
  if (tabOf(paneName)?.virtualMode) {
    return false;
  }
  const entry = entryForPath(paneName, entryPath);
  if (!entry?.isDirectory || entry.unavailable) {
    return false;
  }
  return queueListingPrefetch(paneName, entry.path, reason);
}

function prefetchFocusedFolder(paneName, reason = "focus") {
  const focusedPath = tabOf(paneName)?.focusedPath;
  return focusedPath ? prefetchEntryListing(paneName, focusedPath, reason) : false;
}

function applyPaneListing(paneName, tab, data, context = {}) {
  const {
    pushHistory = true,
    previousPath = "",
    previousSelected = new Set(),
    previousFocusedPath = null,
    options = {}
  } = context;
  const entries = entriesWithCurrentLabels(data.entries);
  if (pushHistory && previousPath && previousPath !== data.path) {
    tab.history.push(previousPath);
    tab.future = [];
  }
  tab.path = data.path;
  tab.parent = data.parent;
  tab.title = labelForPath(data.path);
  tab.entries = entries;
  tab.accessError = data.accessError || null;
  tab.redirectedFrom = data.redirectedFrom || null;
  if (data.folderSignature) {
    tab.folderSignature = data.folderSignature;
  } else if (data.includeSignature === true) {
    tab.folderSignature = null;
  }
  tab.listingIncludesDimensions = data.includeDimensions === true;
  tab.listingIncludesLinks = data.includeLinks === true;
  tab.listingIncludesAttributes = data.includeAttributes === true;
  tab.folderWatchVersion = null;
  tab.listingWindow = data.window ? { ...data.window } : null;
  tab.lastLoadTiming = paneListingTiming(data, { cached: context.cached === true, source: "filesystem" });
  const entryPaths = new Set(entries.map((entry) => entry.path));
  const selectedTargetPath = data.selectedPath && entryPaths.has(data.selectedPath) ? data.selectedPath : null;
  tab.selected = selectedTargetPath
    ? new Set([selectedTargetPath])
    : options.preserveSelection
      ? new Set([...previousSelected].filter((itemPath) => entryPaths.has(itemPath)))
      : new Set();
  tab.focusedPath = selectedTargetPath
    ? selectedTargetPath
    : options.preserveSelection && entryPaths.has(previousFocusedPath)
      ? previousFocusedPath
      : null;
  tab.anchorPath = selectedTargetPath || null;
  tab.searchMode = false;
  tab.virtualMode = "";
  tab.virtual = null;
  const appliedFormat = matchingFolderFormat(data.path);
  if (appliedFormat) {
    applyFormatToTab(tab, appliedFormat);
  }
  rememberLocation(data.path);
  renderPane(paneName);
  renderRoots();
  updateSelectionReadout();
  renderInspector();
  return { appliedFormat, selectedTargetPath, entries };
}

function applyZipPaneListing(paneName, tab, data, context = {}) {
  const {
    pushHistory = true,
    previousPath = "",
    previousSelected = new Set(),
    previousFocusedPath = null,
    options = {}
  } = context;
  const entries = (data.entries || []).map((entry) => withCurrentLabel({ ...entry }));
  if (pushHistory && previousPath && previousPath !== data.path) {
    tab.history.push(previousPath);
    tab.future = [];
  }
  tab.path = data.path;
  tab.parent = data.parent;
  tab.title = data.title || labelForPath(data.path);
  tab.entries = entries;
  tab.folderSignature = data.folderSignature || null;
  tab.listingIncludesDimensions = false;
  tab.listingIncludesLinks = false;
  tab.listingIncludesAttributes = false;
  tab.folderWatchVersion = null;
  tab.listingWindow = null;
  tab.lastLoadTiming = paneListingTiming(data, { cached: context.cached === true, source: "zip" });
  tab.searchMode = false;
  tab.virtualMode = "zip";
  tab.virtual = {
    type: "zip",
    archivePath: data.archivePath,
    innerPath: data.innerPath || "",
    archiveSize: data.archiveSize || 0,
    archiveModified: data.archiveModified || null
  };
  const entryPaths = new Set(entries.map((entry) => entry.path));
  tab.selected = options.preserveSelection
    ? new Set([...previousSelected].filter((itemPath) => entryPaths.has(itemPath)))
    : new Set();
  tab.focusedPath =
    options.preserveSelection && entryPaths.has(previousFocusedPath) ? previousFocusedPath : null;
  tab.anchorPath = tab.focusedPath || null;
  renderPane(paneName);
  renderRoots();
  updateSelectionReadout();
  renderInspector();
  return { entries };
}

function renderRoots() {
  const rootStrip = document.getElementById("root-strip");
  const favorites = app.state?.favorites || [];
  const favoriteItems = favorites.map((favorite) => ({
    ...favorite,
    kind: "favorite",
    name: `* ${favorite.name}`
  }));
  const items = [...favoriteItems, ...app.roots.shortcuts, ...app.roots.drives];
  rootStrip.innerHTML = items
    .map(
      (item) =>
        `<button class="${rootButtonClass(item)}" data-root-path="${escapeHtml(item.path)}" title="${escapeHtml(
          rootTitle(item)
        )}">${escapeHtml(item.name)}</button>`
    )
    .join("");
  document.getElementById("session-root").textContent = app.roots.cwd;

  document.getElementById("nav-favorites").innerHTML = renderNavRows(favorites, {
    empty: "No favorites yet",
    removable: true
  });
  document.getElementById("nav-aliases").innerHTML = renderNavRows(
    pathAliases().map((alias) => ({
      ...alias,
      kind: "alias",
      name: `${alias.name}:`
    })),
    {
      empty: "No aliases yet"
    }
  );
  document.getElementById("nav-shortcuts").innerHTML = renderNavRows(app.roots.shortcuts, {
    empty: "No shortcuts"
  });
  document.getElementById("nav-shell").innerHTML = renderNavRows(shellNavigationItems(), {
    empty: "No shell locations"
  });
  document.getElementById("nav-drives").innerHTML = renderNavRows(app.roots.drives, {
    empty: "No drives"
  });
  document.getElementById("nav-recents").innerHTML = renderNavRows(app.state?.recentLocations || [], {
    empty: "No recent folders",
    recent: true
  });
  renderFolderTree();
}

function rootButtonClass(item) {
  return [
    item.kind === "favorite" ? "favorite-root" : "",
    item.kind === "favorite" ? favoriteColorClass(item.color) : "",
    item.kind === "drive" ? "drive-root" : "",
    driveSpaceLevel(item) ? `drive-${driveSpaceLevel(item)}` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function favoriteColorClass(color) {
  return `favorite-${favoriteColor(color)}`;
}

function favoriteColor(color) {
  return favoriteColorValues.has(color) ? color : "gold";
}

function rootTitle(item) {
  const location = item.path || item.openTarget || item.libraryPath || "";
  const detail = driveSpaceText(item) || (item.detail && item.detail !== location ? item.detail : "");
  return [location, detail].filter(Boolean).join(" / ");
}

function driveSpace(item) {
  return item?.kind === "drive" && item.space?.available ? item.space : null;
}

function driveSpaceText(item) {
  const space = driveSpace(item);
  if (!space) {
    return "";
  }
  return `${formatSize(space.freeBytes)} free of ${formatSize(space.totalBytes)}`;
}

function driveSpaceLevel(item) {
  const space = driveSpace(item);
  if (!space) {
    return "";
  }
  const freePercent = Number(space.freePercent);
  if (freePercent <= 10) {
    return "low";
  }
  if (freePercent <= 20) {
    return "warn";
  }
  return "ok";
}

function driveUsedPercent(item) {
  const space = driveSpace(item);
  if (!space) {
    return 0;
  }
  return Math.max(0, Math.min(100, Number(space.usedPercent || 0)));
}

function driveMeterMarkup(item) {
  const space = driveSpace(item);
  if (!space) {
    return "";
  }
  const level = driveSpaceLevel(item);
  return `<span class="drive-meter drive-${level}" title="${escapeHtml(driveSpaceText(item))}">
    <span style="width:${driveUsedPercent(item).toFixed(1)}%"></span>
  </span>`;
}

function navGlyph(kind) {
  const glyphs = {
    favorite: "FAV",
    home: "HOME",
    desktop: "DESK",
    documents: "DOC",
    downloads: "DOWN",
    pictures: "PIC",
    music: "MUS",
    videos: "VID",
    public: "PUB",
    appData: "APP",
    localAppData: "LOC",
    appTrash: "TR",
    oneDrive: "1DR",
    workspace: "WORK",
    drive: "DRV",
    alias: "AL",
    recent: "REC",
    thisPc: "PC",
    libraries: "LIB",
    library: "LIB",
    network: "NET",
    recycleBin: "BIN"
  };
  return glyphs[kind] || "DIR";
}

function shellNavigationItems() {
  return Array.isArray(app.shellLocations?.navigation) ? app.shellLocations.navigation : [];
}

async function launchShellLocation(id) {
  const result = await request("/api/shell/open", {
    method: "POST",
    body: JSON.stringify({ id })
  });
  setStatus(`Opened ${result.name}`);
  showToast(`Opened ${result.name}`);
  return result;
}

async function openShellLocation(id) {
  if (id === "recycleBin") {
    return openWindowsRecycleDialog();
  }
  return launchShellLocation(id);
}

function shellNamespaceRoots() {
  const roots = Array.isArray(app.shellLocations?.virtualFolders) ? app.shellLocations.virtualFolders : [];
  return roots.filter((item) => item.id !== "recycleBin");
}

function shellNamespaceRootLabel(root) {
  return root?.name || root?.id || "Shell";
}

function shellNamespaceKindCode(item = {}) {
  const kind = String(item.kind || item.type || "").toLowerCase();
  if (item.isPortableDevice || item.isShellDevice || kind.includes("device")) return "DEV";
  if (kind.includes("network")) return "NET";
  if (kind.includes("library")) return "LIB";
  if (kind.includes("drive") || /^[a-z]:\\?$/i.test(item.path || "")) return "DRV";
  if (kind.includes("virtual")) return "VIR";
  if (item.isDirectory || item.isFolder) return "DIR";
  if (item.isFile) return "FILE";
  return "ITEM";
}

function renderShellNamespaceDialog(message = "") {
  const state = app.shellNamespace || {};
  const report = state.report || {};
  const items = Array.isArray(report.items) ? report.items : [];
  const roots = shellNamespaceRoots();
  const activeTarget = String(report.target || state.target || "").toLowerCase();
  document.getElementById("shell-namespace-summary").textContent =
    message ||
    (state.loading
      ? "Reading shell namespace..."
      : report.available === false
      ? report.reason || "Shell namespace unavailable"
      : `${items.length}${report.truncated ? `/${report.total}` : ""} item(s)`);
  document.getElementById("shell-namespace-roots").innerHTML = roots.length
    ? roots
        .map((root) => {
          const rootTarget = String(root.openTarget || root.path || "").toLowerCase();
          const active = root.id === report.id || root.id === state.target || (rootTarget && rootTarget === activeTarget);
          return `<button type="button" class="${active ? "active" : ""}" aria-pressed="${active ? "true" : "false"}" data-shell-namespace-root="${escapeHtml(
            root.id
          )}">${escapeHtml(shellNamespaceRootLabel(root))}</button>`;
        })
        .join("")
    : `<span class="empty-state">No shell roots</span>`;
  document.getElementById("shell-namespace-back").disabled = state.loading || !(state.stack || []).length;
  document.getElementById("shell-namespace-refresh").disabled = Boolean(state.loading);
  document.getElementById("shell-namespace-head").innerHTML = `
    <strong>${escapeHtml(report.name || "Shell Namespace")}</strong>
    <code title="${escapeHtml(report.target || state.target || "")}">${escapeHtml(report.target || state.target || "")}</code>
  `;
  document.getElementById("shell-namespace-list").innerHTML = items.length
    ? items
        .map((item, index) => {
          const detail = item.detail || item.type || item.path || item.kind || "";
          const pathTitle = item.path || item.openTarget || detail;
          const browseButton = item.canBrowse
            ? `<button type="button" data-shell-namespace-browse-index="${index}" title="Browse this shell folder">Browse</button>`
            : "";
          const paneButton = item.canOpenPane
            ? `<button type="button" data-shell-namespace-pane-index="${index}" title="Open this filesystem folder in the active pane">Pane</button>`
            : "";
          const openButton = item.canOpen
            ? `<button type="button" data-shell-namespace-external-index="${index}" title="Open this shell item with Explorer">Open</button>`
            : "";
          return `<div class="shell-namespace-row" data-shell-namespace-index="${index}">
            <span class="shell-namespace-code">${escapeHtml(shellNamespaceKindCode(item))}</span>
            <span>
              <strong title="${escapeHtml(pathTitle)}">${escapeHtml(item.name || labelForPath(item.path))}</strong>
              <small title="${escapeHtml(pathTitle)}">${escapeHtml(detail)}</small>
            </span>
            <span class="shell-namespace-row-actions">${browseButton}${paneButton}${openButton}</span>
          </div>`;
        })
        .join("")
    : `<div class="empty-state">${escapeHtml(report.available === false ? report.reason || "Unavailable" : "No items")}</div>`;
}

function shellNamespaceItemByIndex(value) {
  const index = Number(value);
  const items = Array.isArray(app.shellNamespace?.report?.items) ? app.shellNamespace.report.items : [];
  return Number.isInteger(index) ? items[index] || null : null;
}

function shellNamespaceItemTarget(item) {
  return item?.openTarget || item?.path || "";
}

function writeShellNamespaceError(error, message = "Shell namespace failed") {
  document.getElementById("shell-namespace-summary").textContent = error.message || message;
  document.getElementById("shell-namespace-output").textContent = error.stack || error.message || message;
  showToast(error.message || message);
}

async function browseShellNamespaceIndex(index) {
  const item = shellNamespaceItemByIndex(index);
  const target = shellNamespaceItemTarget(item);
  if (!item?.canBrowse || !target) {
    return showToast("This shell item cannot be browsed");
  }
  await loadShellNamespace(target, { push: true });
}

async function openShellNamespaceIndexExternally(index) {
  const item = shellNamespaceItemByIndex(index);
  const target = shellNamespaceItemTarget(item);
  if (!item?.canOpen || !target) {
    return showToast("This shell item cannot be opened");
  }
  await openShellNamespaceExternally(target);
}

async function openShellNamespaceIndexInPane(index) {
  const item = shellNamespaceItemByIndex(index);
  if (!item?.canOpenPane || !item.path) {
    return showToast("This shell item is not a filesystem folder");
  }
  await openShellNamespaceInPane(item.path);
}

async function loadShellNamespace(target = app.shellNamespace?.target || "thisPc", options = {}) {
  app.shellNamespace = app.shellNamespace || { target: "thisPc", stack: [], report: null, loading: false };
  const previousTarget = app.shellNamespace.target;
  if (options.push !== false && previousTarget && previousTarget !== target) {
    app.shellNamespace.stack = [...(app.shellNamespace.stack || []), previousTarget].slice(-30);
  }
  app.shellNamespace.target = target;
  app.shellNamespace.loading = true;
  document.getElementById("shell-namespace-output").textContent = "";
  renderShellNamespaceDialog("Reading shell namespace...");
  try {
    const params = new URLSearchParams({ target, limit: "160" });
    const report = await request(`/api/shell/namespace?${params}`);
    app.shellNamespace.report = report;
    app.shellNamespace.target = report.target || target;
    app.shellNamespace.loading = false;
    renderShellNamespaceDialog();
    return report;
  } catch (error) {
    app.shellNamespace.loading = false;
    renderShellNamespaceDialog("Shell namespace failed");
    throw error;
  }
}

async function openShellNamespaceDialog(target = "thisPc") {
  app.shellNamespace = {
    target,
    stack: [],
    report: null,
    loading: false
  };
  document.getElementById("shell-namespace-output").textContent = "";
  renderShellNamespaceDialog("Reading shell namespace...");
  document.getElementById("shell-namespace-dialog").showModal();
  try {
    await loadShellNamespace(target, { push: false });
  } catch (error) {
    writeShellNamespaceError(error);
  }
}

async function goBackShellNamespace() {
  const stack = app.shellNamespace?.stack || [];
  const previous = stack.at(-1);
  if (!previous) {
    return showToast("No shell namespace history");
  }
  app.shellNamespace.stack = stack.slice(0, -1);
  await loadShellNamespace(previous, { push: false });
}

async function openShellNamespaceExternally(target) {
  if (!target) {
    return showToast("No shell target");
  }
  const result = await request("/api/shell/namespace/open", {
    method: "POST",
    body: JSON.stringify({ target })
  });
  document.getElementById("shell-namespace-output").textContent = JSON.stringify(result, null, 2);
  setStatus(`Opened shell item: ${labelForPath(result.target || target)}`);
  showToast("Shell item opened");
  return result;
}

async function openShellNamespaceInPane(target) {
  if (!target) {
    return showToast("No filesystem target");
  }
  await loadPane(app.activePane, target);
  document.getElementById("shell-namespace-dialog").close();
  showToast(`Opened ${labelForPath(target)} in ${app.activePane}`);
}

function normalizedPathKey(itemPath) {
  return String(itemPath || "").replace(/[\\/]+$/, "").toLowerCase();
}

function samePath(left, right) {
  return normalizedPathKey(left) === normalizedPathKey(right);
}

function parentPathOf(itemPath) {
  const trimmed = String(itemPath || "").replace(/[\\/]+$/, "");
  const splitAt = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (splitAt <= 0) {
    return trimmed;
  }
  return trimmed.slice(0, splitAt);
}

function pathSeparatorFor(itemPath) {
  return String(itemPath || "").includes("\\") ? "\\" : "/";
}

function siblingPathForName(itemPath, name) {
  const text = String(itemPath || "");
  const splitAt = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
  if (splitAt < 0) {
    return name;
  }
  return `${text.slice(0, splitAt + 1)}${name}`;
}

function joinPathSegment(basePath, segment, separator) {
  if (!basePath || basePath.endsWith("\\") || basePath.endsWith("/")) {
    return `${basePath}${segment}`;
  }
  return `${basePath}${separator}${segment}`;
}

function normalizeZipInnerPath(value) {
  const text = String(value || "")
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!text) {
    return "";
  }
  return text
    .split("/")
    .filter(Boolean)
    .filter((segment) => segment !== "." && segment !== "..")
    .join("/");
}

function encodeZipInnerPath(innerPath) {
  const clean = normalizeZipInnerPath(innerPath);
  return clean
    ? clean
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")
    : "";
}

function zipVirtualPathFor(archivePath, innerPath = "") {
  const encodedInner = encodeZipInnerPath(innerPath);
  return `${zipVirtualPrefix}${encodeURIComponent(archivePath)}!/${encodedInner}`;
}

function isZipVirtualPath(itemPath) {
  const text = String(itemPath || "");
  return text.startsWith(zipVirtualPrefix) && text.includes("!/");
}

function parseZipVirtualPath(itemPath) {
  const text = String(itemPath || "");
  if (!isZipVirtualPath(text)) {
    return null;
  }
  const payload = text.slice(zipVirtualPrefix.length);
  const marker = payload.indexOf("!/");
  if (marker < 0) {
    return null;
  }
  try {
    const archivePath = decodeURIComponent(payload.slice(0, marker));
    const rawInner = payload.slice(marker + 2);
    const innerPath = rawInner
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment))
      .join("/");
    return { archivePath, innerPath: normalizeZipInnerPath(innerPath) };
  } catch {
    return null;
  }
}

function isZipVirtualEntry(entry) {
  return entry?.virtualType === "zip" || isZipVirtualPath(entry?.path);
}

function isRealZipFileEntry(entry) {
  return Boolean(entry?.isFile && !isZipVirtualEntry(entry) && isZipPath(entry.path || entry.name));
}

function pathAliases() {
  return Array.isArray(app.state?.aliases)
    ? app.state.aliases.filter((alias) => alias?.name && alias?.path)
    : [];
}

function normalizeAliasName(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidAliasName(value) {
  return /^[a-z][a-z0-9_-]{1,31}$/.test(normalizeAliasName(value));
}

function aliasByName(name) {
  const key = normalizeAliasName(name);
  return pathAliases().find((alias) => normalizeAliasName(alias.name) === key) || null;
}

function appendAliasSuffix(basePath, suffix) {
  const text = String(suffix || "");
  if (!text) {
    return basePath;
  }
  const trimmed = text.replace(/^[\\/]+/, "");
  if (!trimmed) {
    return basePath;
  }
  const separator = pathSeparatorFor(basePath);
  return trimmed
    .split(/[\\/]+/)
    .filter(Boolean)
    .reduce((current, segment) => joinPathSegment(current, segment, separator), basePath);
}

function expandAliasPath(inputPath) {
  const text = String(inputPath || "").trim();
  const match = text.match(/^([A-Za-z][A-Za-z0-9_-]{1,31}):(.*)$/);
  if (!match) {
    return inputPath;
  }
  const alias = aliasByName(match[1]);
  return alias ? appendAliasSuffix(alias.path, match[2]) : inputPath;
}

function pathSuggestionText(value) {
  return String(value || "").trim().toLowerCase();
}

function suggestionMatches(item, query) {
  const needle = pathSuggestionText(query);
  if (!needle) {
    return true;
  }
  return [item.label, item.path, item.detail, item.kind]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

function addPathSuggestion(items, seen, item) {
  if (!item?.path) {
    return;
  }
  const key = `${item.kind || "path"}:${normalizedPathKey(item.path)}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  items.push(item);
}

function localPathSuggestions(query) {
  const items = [];
  const seen = new Set();
  const addIfMatch = (item) => {
    if (suggestionMatches(item, query)) {
      addPathSuggestion(items, seen, item);
    }
  };

  for (const alias of pathAliases()) {
    addIfMatch({
      kind: "Alias",
      label: `${alias.name}:`,
      path: `${alias.name}:`,
      detail: alias.path
    });
  }

  const roots = [
    ...(app.state?.favorites || []).map((item) => ({ ...item, kind: "Favorite" })),
    ...(app.roots?.shortcuts || []).map((item) => ({ ...item, kind: item.kind || "Root" })),
    ...(app.roots?.drives || []).map((item) => ({ ...item, kind: "Drive" })),
    ...(app.state?.recentLocations || []).map((item) => ({ ...item, kind: "Recent" }))
  ];
  for (const item of roots) {
    addIfMatch({
      kind: item.kind || "Folder",
      label: item.name || labelForPath(item.path),
      path: item.path,
      detail: item.visitedAt ? `Visited ${formatDate(Date.parse(item.visitedAt))}` : item.path
    });
  }

  return items.slice(0, 10);
}

function filesystemSuggestionBase(inputPath) {
  const expanded = expandAliasPath(inputPath).trim();
  if (!expanded) {
    return null;
  }
  const separator = /^[A-Za-z]:/.test(expanded) ? "\\" : pathSeparatorFor(expanded);
  if (/[\\/]$/.test(expanded)) {
    return { parent: expanded, prefix: "", separator };
  }
  if (/^[A-Za-z]:?$/.test(expanded)) {
    return { parent: `${expanded[0]}:${separator}`, prefix: "", separator };
  }
  const splitAt = Math.max(expanded.lastIndexOf("\\"), expanded.lastIndexOf("/"));
  if (splitAt < 0) {
    return null;
  }
  let parent = expanded.slice(0, splitAt);
  if (/^[A-Za-z]:$/.test(parent)) {
    parent = `${parent}${separator}`;
  } else if (!parent && expanded.startsWith(separator)) {
    parent = separator;
  }
  return {
    parent,
    prefix: expanded.slice(splitAt + 1),
    separator
  };
}

async function filesystemPathSuggestions(inputPath) {
  const base = filesystemSuggestionBase(inputPath);
  if (!base?.parent) {
    return [];
  }
  const query = new URLSearchParams({
    path: base.parent,
    showHidden: showHiddenEntriesEnabled() ? "true" : "false"
  });
  const listing = await request(`/api/list?${query}`);
  const prefix = base.prefix.toLowerCase();
  return (listing.entries || [])
    .filter((entry) => entry.isDirectory && !entry.unavailable)
    .filter((entry) => !prefix || entry.name.toLowerCase().startsWith(prefix))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 8)
    .map((entry) => ({
      kind: "Folder",
      label: entry.name,
      path: entry.path,
      detail: listing.path
    }));
}

function renderPathSuggestions() {
  const paneName = app.pathSuggest?.paneName;
  document.querySelectorAll("[data-path-suggest]").forEach((container) => {
    const active = paneName && container.dataset.pathSuggest === paneName;
    if (!active || !app.pathSuggest.items.length) {
      container.hidden = true;
      container.innerHTML = "";
      return;
    }
    container.hidden = false;
    positionPathSuggestion(container, paneName);
    container.innerHTML = app.pathSuggest.items
      .map((item, index) => {
        const selected = app.pathSuggest.keyboardSelected && index === app.pathSuggest.activeIndex ? " active" : "";
        return `<button type="button" class="path-suggest-item${selected}" data-path-suggest-index="${index}" title="${escapeHtml(
          item.path
        )}">
          <span>${escapeHtml(item.kind || "Path")}</span>
          <strong>${escapeHtml(item.label || labelForPath(item.path))}</strong>
          <code>${escapeHtml(item.path)}</code>
          <small>${escapeHtml(item.detail || "")}</small>
        </button>`;
      })
      .join("");
  });
}

function positionPathSuggestion(container, paneName) {
  const input = document.querySelector(`[data-path-input="${paneName}"]`);
  const rect = input?.getBoundingClientRect();
  if (!rect?.width) {
    return;
  }
  const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 16);
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(Math.max(8, rect.bottom + 4), Math.max(8, window.innerHeight - 96));
  container.style.left = `${left}px`;
  container.style.top = `${top}px`;
  container.style.width = `${width}px`;
  container.style.right = "auto";
}

function hidePathSuggestions(paneName = null) {
  if (paneName && app.pathSuggest?.paneName && app.pathSuggest.paneName !== paneName) {
    return;
  }
  app.pathSuggest = {
    paneName: null,
    items: [],
    activeIndex: 0,
    keyboardSelected: false,
    requestId: (app.pathSuggest?.requestId || 0) + 1
  };
  renderPathSuggestions();
}

async function showPathSuggestions(paneName, query) {
  const requestId = (app.pathSuggest?.requestId || 0) + 1;
  const preferFilesystem = Boolean(filesystemSuggestionBase(query));
  const localItems = localPathSuggestions(query);
  app.pathSuggest = {
    paneName,
    items: preferFilesystem ? [] : localItems,
    activeIndex: 0,
    keyboardSelected: false,
    requestId,
    pending: preferFilesystem
  };
  renderPathSuggestions();
  try {
    const filesystemItems = await filesystemPathSuggestions(query);
    if (app.pathSuggest.requestId !== requestId || app.pathSuggest.paneName !== paneName) {
      return;
    }
    const merged = [];
    const seen = new Set();
    const orderedItems = preferFilesystem
      ? [...filesystemItems, ...localItems]
      : [...app.pathSuggest.items, ...filesystemItems];
    for (const item of orderedItems) {
      addPathSuggestion(merged, seen, item);
    }
    app.pathSuggest.items = merged.slice(0, 12);
    app.pathSuggest.activeIndex = Math.min(app.pathSuggest.activeIndex, Math.max(0, app.pathSuggest.items.length - 1));
    app.pathSuggest.pending = false;
    renderPathSuggestions();
  } catch {
    if (app.pathSuggest.requestId === requestId) {
      app.pathSuggest.pending = false;
      if (!app.pathSuggest.items.length) {
        renderPathSuggestions();
      }
    }
  }
}

async function waitForPathSuggestionReady(paneName, requestId) {
  for (let index = 0; index < 12; index += 1) {
    if (app.pathSuggest?.paneName !== paneName || app.pathSuggest.requestId !== requestId) {
      return;
    }
    if (!app.pathSuggest.pending) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
}

async function acceptPathSuggestion(pathInput, options = {}) {
  const paneName = pathInput.dataset.pathInput;
  const item = app.pathSuggest?.paneName === paneName ? app.pathSuggest.items[app.pathSuggest.activeIndex] : null;
  if (!item) {
    return false;
  }
  pathInput.value = item.path;
  hidePathSuggestions(paneName);
  if (options.open) {
    app.activePane = paneName;
    await loadPane(paneName, item.path);
    focusPaneList(paneName);
  } else {
    pathInput.focus();
    pathInput.setSelectionRange(pathInput.value.length, pathInput.value.length);
  }
  return true;
}

async function handlePathSuggestionKey(event, pathInput) {
  const paneName = pathInput.dataset.pathInput;
  const active = app.pathSuggest?.paneName === paneName && app.pathSuggest.items.length;
  if (event.key === "Escape" && active) {
    event.preventDefault();
    hidePathSuggestions(paneName);
    return true;
  }
  if (!active) {
    const pending =
      app.pathSuggest?.paneName === paneName &&
      app.pathSuggest.pending &&
      event.key === "Tab";
    if (pending) {
      event.preventDefault();
      const requestId = app.pathSuggest.requestId;
      await waitForPathSuggestionReady(paneName, requestId);
      if (app.pathSuggest?.paneName === paneName && app.pathSuggest.items.length) {
        await acceptPathSuggestion(pathInput, { open: false });
      }
      return true;
    }
    return false;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const count = app.pathSuggest.items.length;
    app.pathSuggest.activeIndex = (app.pathSuggest.activeIndex + direction + count) % count;
    app.pathSuggest.keyboardSelected = true;
    renderPathSuggestions();
    return true;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    await acceptPathSuggestion(pathInput, { open: false });
    return true;
  }
  if (event.key === "Enter") {
    if (!app.pathSuggest.keyboardSelected) {
      return false;
    }
    event.preventDefault();
    await acceptPathSuggestion(pathInput, { open: true });
    return true;
  }
  return false;
}

function splitPathForLink(itemPath) {
  const raw = String(itemPath || "").trim();
  const separator = /^[A-Za-z]:$/.test(raw) ? "\\" : pathSeparatorFor(raw);
  const text = raw.replace(/[\\/]+$/, "");
  if (!text) {
    return { root: "", segments: [], separator };
  }
  if (/^[A-Za-z]:$/.test(text)) {
    return { root: `${text}${separator}`, segments: [], separator };
  }
  if (/^[A-Za-z]:[\\/]/.test(text)) {
    return {
      root: text.slice(0, 3),
      segments: text.slice(3).split(/[\\/]+/).filter(Boolean),
      separator: text[2] || separator
    };
  }
  if (text.startsWith("\\\\")) {
    const parts = text.split(/[\\/]+/).filter(Boolean);
    if (parts.length >= 2) {
      return {
        root: `\\\\${parts[0]}\\${parts[1]}\\`,
        segments: parts.slice(2),
        separator: "\\"
      };
    }
  }
  if (text.startsWith("/")) {
    return {
      root: "/",
      segments: text.slice(1).split(/[\\/]+/).filter(Boolean),
      separator: "/"
    };
  }
  return {
    root: "",
    segments: text.split(/[\\/]+/).filter(Boolean),
    separator
  };
}

function segmentKey(value) {
  return String(value || "").toLowerCase();
}

function segmentsStartWith(segments, prefix) {
  return prefix.every((segment, index) => segmentKey(segments[index]) === segmentKey(segment));
}

function segmentsEndWith(segments, suffix) {
  if (suffix.length > segments.length) {
    return false;
  }
  const offset = segments.length - suffix.length;
  return suffix.every((segment, index) => segmentKey(segments[offset + index]) === segmentKey(segment));
}

function buildPathFromLinkParts(root, segments, separator) {
  if (!root) {
    return segments.join(separator);
  }
  if (!segments.length) {
    return root;
  }
  const joiner = root.endsWith("\\") || root.endsWith("/") ? "" : separator;
  return `${root}${joiner}${segments.join(separator)}`;
}

function relativeSegments(basePath, targetPath) {
  const base = splitPathForLink(basePath);
  const target = splitPathForLink(targetPath);
  if (segmentKey(base.root) !== segmentKey(target.root)) {
    return null;
  }
  if (!segmentsStartWith(target.segments, base.segments)) {
    return null;
  }
  return target.segments.slice(base.segments.length);
}

function appendPathSegments(basePath, segments) {
  const parts = splitPathForLink(basePath);
  return buildPathFromLinkParts(parts.root, [...parts.segments, ...segments], parts.separator);
}

function removeTrailingPathSegments(itemPath, suffix) {
  const parts = splitPathForLink(itemPath);
  if (!suffix.length || !segmentsEndWith(parts.segments, suffix)) {
    return null;
  }
  return buildPathFromLinkParts(parts.root, parts.segments.slice(0, -suffix.length), parts.separator);
}

function replaceTrailingPathSegments(itemPath, oldSuffix, newSuffix) {
  const parts = splitPathForLink(itemPath);
  if (!oldSuffix.length || !segmentsEndWith(parts.segments, oldSuffix)) {
    return null;
  }
  return buildPathFromLinkParts(
    parts.root,
    [...parts.segments.slice(0, -oldSuffix.length), ...newSuffix],
    parts.separator
  );
}

function lastPathSegment(itemPath) {
  return splitPathForLink(itemPath).segments.at(-1) || "";
}

function linkedNavigationTarget(previousPath, nextPath, otherCurrentPath) {
  if (!previousPath || !nextPath || !otherCurrentPath || samePath(previousPath, nextPath)) {
    return null;
  }

  const descendantSegments = relativeSegments(previousPath, nextPath);
  if (descendantSegments?.length) {
    return appendPathSegments(otherCurrentPath, descendantSegments);
  }

  const ancestorSegments = relativeSegments(nextPath, previousPath);
  if (ancestorSegments?.length) {
    return removeTrailingPathSegments(otherCurrentPath, ancestorSegments);
  }

  const previousParent = parentPathOf(previousPath);
  const nextParent = parentPathOf(nextPath);
  const previousName = lastPathSegment(previousPath);
  const nextName = lastPathSegment(nextPath);
  if (previousParent && nextParent && samePath(previousParent, nextParent) && previousName && nextName) {
    return replaceTrailingPathSegments(otherCurrentPath, [previousName], [nextName]);
  }

  return null;
}

function breadcrumbParts(itemPath) {
  const text = String(itemPath || "").trim();
  if (!text) {
    return [];
  }
  const separator = pathSeparatorFor(text);
  const parts = [];
  let root = "";
  let remainder = text;

  if (/^[A-Za-z]:[\\/]/.test(text)) {
    root = text.slice(0, 3);
    remainder = text.slice(3);
  } else if (text.startsWith("\\\\")) {
    const uncParts = text.split(/[\\/]+/).filter(Boolean);
    if (uncParts.length >= 2) {
      root = `\\\\${uncParts[0]}\\${uncParts[1]}\\`;
      remainder = uncParts.slice(2).join("\\");
    }
  } else if (text.startsWith("/")) {
    root = "/";
    remainder = text.slice(1);
  }

  if (root) {
    parts.push({ label: root, path: root });
  }

  let current = root || "";
  const segments = remainder.split(/[\\/]+/).filter(Boolean);
  for (const segment of segments) {
    current = current ? joinPathSegment(current, segment, separator) : segment;
    parts.push({ label: segment, path: current });
  }

  return parts.length ? parts : [{ label: text, path: text }];
}

function zipBreadcrumbParts(itemPath) {
  const zipTarget = parseZipVirtualPath(itemPath);
  if (!zipTarget) {
    return null;
  }
  const parts = [
    {
      label: labelForPath(zipTarget.archivePath),
      path: zipVirtualPathFor(zipTarget.archivePath, "")
    }
  ];
  let current = "";
  for (const segment of zipTarget.innerPath.split("/").filter(Boolean)) {
    current = current ? `${current}/${segment}` : segment;
    parts.push({ label: segment, path: zipVirtualPathFor(zipTarget.archivePath, current) });
  }
  return parts;
}

function renderBreadcrumbs(paneName, itemPath) {
  const zipParts = zipBreadcrumbParts(itemPath);
  const parts = zipParts || breadcrumbParts(itemPath);
  if (!parts.length) {
    return "";
  }
  const separatorText = zipParts ? "/" : pathSeparatorFor(itemPath);
  return parts
    .map((part, index) => {
      const last = index === parts.length - 1;
      const separator = index ? `<span class="breadcrumb-separator" aria-hidden="true">${separatorText}</span>` : "";
      const menuButton = zipParts
        ? ""
        : `<button class="breadcrumb-menu-button" data-breadcrumb-menu-pane="${paneName}" data-breadcrumb-menu-path="${escapeHtml(
            part.path
          )}" title="Show child folders" aria-label="Show child folders">v</button>`;
      return `${separator}<span class="breadcrumb-segment${last ? " current" : ""}">
        <button class="breadcrumb-button${last ? " current" : ""}" data-breadcrumb-pane="${paneName}" data-breadcrumb-path="${escapeHtml(
          part.path
        )}" title="${escapeHtml(part.path)}">${escapeHtml(part.label)}</button>
        ${menuButton}
      </span>`;
    })
    .join("");
}

function toggleCompactBreadcrumbs(paneName, force = null) {
  if (!isPaneName(paneName)) return false;
  const pane = document.querySelector(`.pane[data-pane="${paneName}"]`);
  const button = document.querySelector(`[data-compact-breadcrumbs="${paneName}"]`);
  if (!pane || !button) return false;
  const open = force === null ? !pane.classList.contains("compact-breadcrumbs-open") : Boolean(force);
  pane.classList.toggle("compact-breadcrumbs-open", open);
  button.setAttribute("aria-expanded", String(open));
  button.setAttribute("aria-label", open ? "Hide breadcrumbs" : "Show breadcrumbs");
  button.setAttribute("title", open ? "Hide breadcrumbs" : "Show breadcrumbs");
  if (open) {
    pane.querySelector(".breadcrumb-button.current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  return open;
}

function closeCompactBreadcrumbs(exceptPane = null) {
  for (const paneName of ["left", "right"]) {
    if (paneName !== exceptPane) toggleCompactBreadcrumbs(paneName, false);
  }
}

function breadcrumbMenuElement() {
  let menu = document.getElementById("breadcrumb-menu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "breadcrumb-menu";
    menu.className = "breadcrumb-menu";
    menu.hidden = true;
    document.body.append(menu);
  }
  return menu;
}

function positionBreadcrumbMenu(menu) {
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(app.breadcrumbMenu.x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(app.breadcrumbMenu.y, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function renderBreadcrumbMenu() {
  const menu = breadcrumbMenuElement();
  const state = app.breadcrumbMenu;
  if (!state?.paneName || !state.path) {
    menu.hidden = true;
    menu.innerHTML = "";
    return;
  }
  const entries = Array.isArray(state.entries) ? state.entries : [];
  const rows = entries.length
    ? entries
        .map((entry) => {
          const detail = [entry.attributeText, formatDate(entry.modified), entry.hasChildren ? "subfolders" : ""]
            .filter(Boolean)
            .join(" / ");
          return `<div class="breadcrumb-menu-row">
            <button type="button" class="breadcrumb-menu-main" data-breadcrumb-child-pane="${escapeHtml(
              state.paneName
            )}" data-breadcrumb-child-path="${escapeHtml(entry.path)}" title="${escapeHtml(entry.path)}">
              <span>DIR</span>
              <strong>${escapeHtml(entry.name)}</strong>
              <small>${escapeHtml(detail || entry.path)}</small>
            </button>
            <button type="button" class="breadcrumb-menu-other" data-breadcrumb-child-other-pane="${escapeHtml(
              state.paneName
            )}" data-breadcrumb-child-other-path="${escapeHtml(
              entry.path
            )}" title="Open in other pane" aria-label="Open in other pane">&gt;</button>
          </div>`;
        })
        .join("")
    : state.loading
      ? `<div class="breadcrumb-menu-message">Loading...</div>`
      : state.error
        ? `<div class="breadcrumb-menu-message error">${escapeHtml(state.error)}</div>`
        : `<div class="breadcrumb-menu-message">No child folders</div>`;
  menu.innerHTML = `
    <div class="breadcrumb-menu-title">
      <strong>${escapeHtml(labelForPath(state.path))}</strong>
      <small>${escapeHtml(state.path)}</small>
    </div>
    <div class="breadcrumb-menu-list">${rows}</div>
  `;
  menu.hidden = false;
  positionBreadcrumbMenu(menu);
}

function hideBreadcrumbMenu() {
  app.breadcrumbMenu = {
    paneName: null,
    path: null,
    entries: [],
    loading: false,
    error: null,
    requestId: (app.breadcrumbMenu?.requestId || 0) + 1,
    x: 0,
    y: 0
  };
  renderBreadcrumbMenu();
}

async function openBreadcrumbMenu(paneName, itemPath, anchor) {
  const rect = anchor.getBoundingClientRect();
  const requestId = (app.breadcrumbMenu?.requestId || 0) + 1;
  app.breadcrumbMenu = {
    paneName,
    path: itemPath,
    entries: [],
    loading: true,
    error: null,
    requestId,
    x: rect.left,
    y: rect.bottom + 6
  };
  renderBreadcrumbMenu();
  try {
    const query = new URLSearchParams({
      path: itemPath,
      limit: "80",
      showHidden: showHiddenEntriesEnabled() ? "true" : "false",
      includeStats: "false",
      includeChildState: "false"
    });
    const node = await request(`/api/tree?${query}`);
    if (app.breadcrumbMenu.requestId !== requestId) {
      return;
    }
    app.breadcrumbMenu.entries = node.entries || [];
    app.breadcrumbMenu.loading = false;
    app.breadcrumbMenu.error = node.error || null;
    renderBreadcrumbMenu();
  } catch (error) {
    if (app.breadcrumbMenu.requestId !== requestId) {
      return;
    }
    app.breadcrumbMenu.entries = [];
    app.breadcrumbMenu.loading = false;
    app.breadcrumbMenu.error = error.message;
    renderBreadcrumbMenu();
  }
}

const labelColors = [
  { id: "teal", name: "Teal" },
  { id: "gold", name: "Gold" },
  { id: "ember", name: "Ember" },
  { id: "violet", name: "Violet" },
  { id: "green", name: "Green" },
  { id: "black", name: "Black" }
];

function pathLabelFor(itemPath) {
  const key = normalizedPathKey(itemPath);
  return (app.state?.labels || []).find((label) => normalizedPathKey(label.path) === key) || null;
}

function withCurrentLabel(entry) {
  const label = pathLabelFor(entry.path);
  if (label) {
    return {
      ...entry,
      label: {
        name: label.name,
        color: label.color,
        notes: label.notes,
        updatedAt: label.updatedAt
      }
    };
  }
  const { label: _oldLabel, ...rest } = entry;
  return rest;
}

function entriesWithCurrentLabels(entries) {
  const source = Array.isArray(entries) ? entries : [];
  const labels = app.state?.labels || [];
  if (!labels.length) {
    return source;
  }
  const cached = app.currentLabelEntriesCache.get(source);
  if (cached?.labels === labels) {
    return cached.entries;
  }
  const parent = source[0]?.parent || "";
  const relevantLabels = parent ? labels.filter((label) => samePath(parentPathOf(label.path), parent)) : labels;
  if (!relevantLabels.length) {
    app.currentLabelEntriesCache.set(source, { labels, entries: source });
    return source;
  }
  const labelsByPath = new Map(relevantLabels.map((label) => [normalizedPathKey(label.path), label]));
  const labelledEntries = source.map((entry) => {
    const label = labelsByPath.get(normalizedPathKey(entry.path));
    if (label) {
      return {
        ...entry,
        label: {
          name: label.name,
          color: label.color,
          notes: label.notes,
          updatedAt: label.updatedAt
        }
      };
    }
    if (!entry.label) {
      return entry;
    }
    const { label: _oldLabel, ...rest } = entry;
    return rest;
  });
  app.currentLabelEntriesCache.set(source, { labels, entries: labelledEntries });
  return labelledEntries;
}

function refreshOpenEntryLabels() {
  for (const paneName of ["left", "right"]) {
    for (const tab of panes[paneName].tabs) {
      tab.entries = tab.entries.map(withCurrentLabel);
    }
  }
}

function labelBadgeMarkup(label) {
  if (!label) {
    return "";
  }
  const color = labelColors.some((item) => item.id === label.color) ? label.color : "teal";
  const title = [label.name, label.notes].filter(Boolean).join(" - ");
  return `<span class="entry-label label-${escapeHtml(color)}" title="${escapeHtml(title)}">${escapeHtml(
    label.name || "Marked"
  )}</span>`;
}

function labelNotesText(entry) {
  return String(entry?.label?.notes || "").trim();
}

function renderLabelFilterOptions(activeValue = "all") {
  const active = activeValue || "all";
  const baseOptions = [
    { id: "all", name: "All labels" },
    { id: "any", name: "Any label" },
    ...labelColors
  ];
  return baseOptions
    .map(
      (item) =>
        `<option value="${escapeHtml(item.id)}" ${item.id === active ? "selected" : ""}>${escapeHtml(
          item.name
        )}</option>`
    )
    .join("");
}

const detailColumnDefs = [
  { id: "name", title: "Name", grid: "minmax(84px, 1.35fr)", sortKey: "name", required: true },
  { id: "kind", title: "Kind", grid: "minmax(56px, 0.55fr)", sortKey: "kind" },
  { id: "extension", title: "Ext", grid: "minmax(38px, 0.4fr)", sortKey: "extension" },
  { id: "size", title: "Size", grid: "minmax(54px, 0.48fr)", sortKey: "size" },
  { id: "dimensions", title: "Dim", grid: "minmax(52px, 0.48fr)", sortKey: "dimensions" },
  { id: "attributes", title: "Attr", grid: "minmax(48px, 0.42fr)", sortKey: "attributes" },
  { id: "linkType", title: "Link", grid: "minmax(58px, 0.56fr)", sortKey: "linkType" },
  { id: "linkTarget", title: "Target", grid: "minmax(84px, 0.9fr)", sortKey: "linkTarget" },
  { id: "modified", title: "Modified", grid: "minmax(74px, 0.82fr)", sortKey: "modified" },
  { id: "created", title: "Created", grid: "minmax(74px, 0.82fr)", sortKey: "created" },
  { id: "accessed", title: "Accessed", grid: "minmax(74px, 0.82fr)", sortKey: "accessed" },
  { id: "label", title: "Label", grid: "minmax(58px, 0.6fr)", sortKey: "label" },
  { id: "notes", title: "Notes", grid: "minmax(80px, 0.78fr)", sortKey: "notes" },
  { id: "parent", title: "Parent", grid: "minmax(84px, 0.9fr)", sortKey: "parent" }
];

const columnWidthMinimums = {
  name: 150,
  kind: 72,
  extension: 56,
  size: 70,
  dimensions: 72,
  attributes: 64,
  linkType: 76,
  linkTarget: 140,
  modified: 112,
  created: 112,
  accessed: 112,
  label: 92,
  notes: 120,
  parent: 140
};
const columnWidthMaximum = 860;
const columnAutosizeSampleLimit = 600;
const columnPresetDefinitions = [
  {
    id: "default",
    name: "Default",
    columns: ["name", "kind", "size", "modified"],
    widths: {}
  },
  {
    id: "media",
    name: "Media",
    columns: ["name", "kind", "dimensions", "size", "modified"],
    widths: { name: 260, kind: 104, dimensions: 96, size: 92, modified: 138 }
  },
  {
    id: "code",
    name: "Code",
    columns: ["name", "extension", "size", "modified", "created", "attributes"],
    widths: { name: 300, extension: 72, size: 88, modified: 138, created: 138, attributes: 76 }
  },
  {
    id: "downloads",
    name: "Downloads",
    columns: ["name", "kind", "size", "modified", "created"],
    widths: { name: 300, kind: 112, size: 92, modified: 138, created: 138 }
  },
  {
    id: "photos",
    name: "Photos",
    columns: ["name", "dimensions", "size", "modified", "created"],
    widths: { name: 280, dimensions: 104, size: 92, modified: 138, created: 138 }
  }
];

function defaultColumns() {
  return ["name", "kind", "size", "modified"];
}

function normalizeColumns(columns) {
  const allowed = new Set(detailColumnDefs.map((column) => column.id));
  const selected = [];
  for (const column of Array.isArray(columns) ? columns : defaultColumns()) {
    if (allowed.has(column) && !selected.includes(column)) {
      selected.push(column);
    }
  }
  if (!selected.includes("name")) {
    selected.unshift("name");
  }
  return selected.slice(0, detailColumnDefs.length);
}

function columnDefById(columnId) {
  return detailColumnDefs.find((column) => column.id === columnId) || null;
}

function columnMinWidth(columnId) {
  return columnWidthMinimums[columnId] || 64;
}

function normalizeColumnWidth(columnId, value, fallback = null) {
  const fallbackValue = fallback === null ? columnDefaultPixelWidth(columnId) : fallback;
  return Math.round(clampNumber(value, columnMinWidth(columnId), columnWidthMaximum, fallbackValue));
}

function normalizeColumnWidths(widths = {}) {
  const raw = widths && typeof widths === "object" ? widths : {};
  const allowed = new Set(detailColumnDefs.map((column) => column.id));
  const clean = {};
  for (const [columnId, width] of Object.entries(raw)) {
    if (allowed.has(columnId) && Number.isFinite(Number(width))) {
      clean[columnId] = normalizeColumnWidth(columnId, width);
    }
  }
  return clean;
}

function columnDefaultPixelWidth(columnId) {
  const column = columnDefById(columnId);
  if (!column) {
    return 96;
  }
  const exactPixel = String(column.grid || "").match(/^(\d+)px$/);
  if (exactPixel) {
    return Number(exactPixel[1]);
  }
  const minPixel = String(column.grid || "").match(/minmax\((\d+)px,/);
  if (minPixel) {
    return Math.max(Number(minPixel[1]), columnId === "name" ? 240 : 180);
  }
  return Math.max(columnMinWidth(columnId), 96);
}

function columnGridTrack(column, tab) {
  const widths = normalizeColumnWidths(tab?.columnWidths);
  const width = widths[column.id];
  return Number.isFinite(width) ? `${width}px` : column.grid;
}

function displaySnapshotNeedsDimensions(snapshot = {}) {
  return snapshot.sortKey === "dimensions" || normalizeColumns(snapshot.columns).includes("dimensions");
}

function tabNeedsDimensions(tab) {
  return tab?.sortKey === "dimensions" || normalizeColumns(tab?.columns).includes("dimensions");
}

function listingNeedsDimensions(tab, targetPath = tab?.path) {
  const format = targetPath ? matchingFolderFormat(targetPath) : null;
  return displaySnapshotNeedsDimensions(format?.format) || tabNeedsDimensions(tab);
}

const linkMetadataColumns = new Set(["linkType", "linkTarget"]);

function displaySnapshotNeedsLinks(snapshot = {}) {
  return (
    linkMetadataColumns.has(snapshot.sortKey) ||
    normalizeColumns(snapshot.columns).some((id) => linkMetadataColumns.has(id))
  );
}

function tabNeedsLinks(tab) {
  return (
    linkMetadataColumns.has(tab?.sortKey) ||
    normalizeColumns(tab?.columns).some((id) => linkMetadataColumns.has(id))
  );
}

function listingNeedsLinks(tab, targetPath = tab?.path) {
  const format = targetPath ? matchingFolderFormat(targetPath) : null;
  return displaySnapshotNeedsLinks(format?.format) || tabNeedsLinks(tab);
}

function displaySnapshotNeedsAttributes(snapshot = {}) {
  return snapshot.sortKey === "attributes" || normalizeColumns(snapshot.columns).includes("attributes");
}

function tabNeedsAttributes(tab) {
  return tab?.sortKey === "attributes" || normalizeColumns(tab?.columns).includes("attributes");
}

function listingNeedsAttributes(tab, targetPath = tab?.path, showHidden = showHiddenEntriesEnabled()) {
  if (!showHidden) {
    return true;
  }
  const format = targetPath ? matchingFolderFormat(targetPath) : null;
  return displaySnapshotNeedsAttributes(format?.format) || tabNeedsAttributes(tab);
}

function tabNeedsUnloadedMetadata(tab) {
  if (!tab || tab.searchMode || tab.virtualMode) {
    return false;
  }
  return (
    (tabNeedsDimensions(tab) && !tab.listingIncludesDimensions) ||
    (tabNeedsLinks(tab) && !tab.listingIncludesLinks) ||
    (tabNeedsAttributes(tab) && !tab.listingIncludesAttributes)
  );
}

function columnsForTab(tab) {
  const ids = normalizeColumns(tab?.columns);
  return ids.map((id) => detailColumnDefs.find((column) => column.id === id)).filter(Boolean);
}

function columnGridFor(tab) {
  return columnsForTab(tab).map((column) => columnGridTrack(column, tab)).join(" ");
}

function sortableValue(entry, sortKey) {
  if (sortKey === "label") {
    return entry.label?.name || "";
  }
  if (sortKey === "notes") {
    return labelNotesText(entry);
  }
  if (sortKey === "extension") {
    return entry.extension || "";
  }
  if (sortKey === "attributes") {
    return attributeText(entry);
  }
  if (sortKey === "dimensions") {
    return Number(entry.dimensionPixels || entry.dimensions?.pixels || 0);
  }
  if (sortKey === "linkType") {
    return linkTypeText(entry);
  }
  if (sortKey === "linkTarget") {
    return linkTargetText(entry);
  }
  return entry[sortKey] ?? "";
}

function pathInsideFolder(candidatePath, folderPath) {
  const candidate = normalizedPathKey(candidatePath);
  const folder = normalizedPathKey(folderPath);
  return candidate === folder || candidate.startsWith(`${folder}\\`) || candidate.startsWith(`${folder}/`);
}

function folderFormatSnapshot(tab = tabOf(app.activePane)) {
  return {
    viewMode: tab.viewMode,
    sortKey: tab.sortKey,
    sortDir: tab.sortDir,
    columns: normalizeColumns(tab.columns),
    columnWidths: normalizeColumnWidths(tab.columnWidths),
    kindFilter: normalizeKindFilter(tab.kindFilter),
    labelFilter: tab.labelFilter || "all"
  };
}

function displaySnapshotSummary(snapshot = {}) {
  const columns = normalizeColumns(snapshot.columns).join(", ");
  const kind = normalizeKindFilter(snapshot.kindFilter);
  const kindText = kind === "all" ? "" : ` / ${kindFilterLabel(kind)}`;
  return `${snapshot.viewMode || "details"} / ${snapshot.sortKey || "name"} ${
    snapshot.sortDir || "asc"
  } / ${columns}${kindText}`;
}

function matchingFolderFormat(folderPath) {
  const formats = app.state?.folderFormats || [];
  const matches = formats.filter((format) => {
    if (!format?.path) {
      return false;
    }
    if (format.match === "subtree") {
      return pathInsideFolder(folderPath, format.path);
    }
    return samePath(folderPath, format.path);
  });
  matches.sort((a, b) => {
    const exactDelta = (b.match === "exact") - (a.match === "exact");
    if (exactDelta) {
      return exactDelta;
    }
    return normalizedPathKey(b.path).length - normalizedPathKey(a.path).length;
  });
  return matches[0] || null;
}

function applyFormatToTab(tab, format) {
  if (!format?.format) {
    return false;
  }
  return applyDisplaySnapshotToTab(tab, format.format);
}

function applyDisplaySnapshotToTab(tab, snapshot = {}) {
  tab.viewMode = ["details", "compact", "tiles"].includes(snapshot.viewMode)
    ? snapshot.viewMode
    : tab.viewMode;
  tab.sortKey = detailColumnDefs.some((column) => column.sortKey === snapshot.sortKey)
    ? snapshot.sortKey
    : "name";
  tab.sortDir = snapshot.sortDir === "desc" ? "desc" : "asc";
  tab.columns = normalizeColumns(snapshot.columns);
  tab.columnWidths = normalizeColumnWidths(snapshot.columnWidths);
  tab.kindFilter = normalizeKindFilter(snapshot.kindFilter);
  tab.labelFilter = snapshot.labelFilter || "all";
  return true;
}

function renderNavRows(items, options = {}) {
  if (!items.length) {
    return `<div class="nav-empty">${escapeHtml(options.empty || "Empty")}</div>`;
  }
  const activePath = tabOf(app.activePane)?.path;
  return items
    .map((item) => {
      const kind = options.recent ? "recent" : item.kind || "folder";
      const canOpenPane = Boolean(item.path);
      const canOpenShell = Boolean(item.id && item.openTarget);
      const active =
        canOpenPane && (samePath(item.path, activePath) || (kind === "drive" && pathInsideFolder(activePath, item.path)))
          ? " active"
          : "";
      const driveDetail = driveSpaceText(item);
      const detail =
        driveDetail ||
        item.detail ||
        (options.recent && item.visitedAt ? formatDate(item.visitedAt) : item.path || item.openTarget || "");
      const driveMeter = driveMeterMarkup(item);
      const removeButton = options.removable
        ? `<button class="nav-mini danger" data-remove-favorite="${escapeHtml(
            item.id
          )}" title="Remove favorite" aria-label="Remove favorite">X</button>`
        : "";
      const favoriteClass = kind === "favorite" ? ` nav-favorite-row ${favoriteColorClass(item.color)}` : "";
      const mainAction = canOpenPane
        ? `data-root-path="${escapeHtml(item.path)}"`
        : canOpenShell
          ? `data-shell-open="${escapeHtml(item.id)}"`
          : "disabled";
      const mainLabel = canOpenPane ? `Open ${item.name || labelForPath(item.path)}` : `Open ${item.name}`;
      const sideAction = canOpenPane
        ? `<button class="nav-mini" data-nav-open-other="${escapeHtml(
            item.path
          )}" title="Open in other pane" aria-label="Open in other pane">&gt;</button>`
        : canOpenShell
          ? `<button class="nav-mini" data-shell-open="${escapeHtml(
              item.id
            )}" title="Open in Explorer" aria-label="Open in Explorer">EX</button>`
          : `<button class="nav-mini" disabled aria-label="Unavailable">-</button>`;
      return `<div class="nav-row${active}${kind === "drive" ? " nav-drive-row" : ""}${favoriteClass}">
        <button class="nav-main" ${mainAction} title="${escapeHtml(rootTitle(item))}" aria-label="${escapeHtml(mainLabel)}">
          <span class="nav-code">${escapeHtml(navGlyph(kind))}</span>
          <span class="nav-text">
            <span>${escapeHtml(item.name || labelForPath(item.path))}</span>
            <small>${escapeHtml(detail)}</small>
            ${driveMeter}
          </span>
        </button>
        ${sideAction}
        ${removeButton}
      </div>`;
    })
    .join("");
}

function folderTreeRoots() {
  const seen = new Set();
  const roots = [];
  const addRoot = (item) => {
    if (!item?.path) {
      return;
    }
    const key = normalizedPathKey(item.path);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    roots.push({ ...item, hasChildren: true });
  };
  for (const item of app.roots?.shortcuts || []) {
    addRoot(item);
  }
  for (const item of app.roots?.drives || []) {
    addRoot(item);
  }
  return roots;
}

function folderTreeNodeFor(itemPath) {
  return app.folderTree.nodes.get(normalizedPathKey(itemPath));
}

function renderFolderTree() {
  const tree = document.getElementById("folder-tree");
  if (!tree) {
    return;
  }
  const roots = folderTreeRoots();
  if (!roots.length) {
    tree.innerHTML = `<div class="nav-empty">No folders</div>`;
    return;
  }
  tree.innerHTML = roots.map((item) => renderFolderTreeNode(item, 0)).join("");
}

function renderFolderTreeNode(item, depth) {
  const itemPath = item.path;
  const key = normalizedPathKey(itemPath);
  const activePath = tabOf(app.activePane)?.path;
  const knownLeaf = app.folderTree.leafPaths.has(key);
  const expanded = !knownLeaf && app.folderTree.expanded.has(key);
  const loading = app.folderTree.loading.has(key);
  const node = folderTreeNodeFor(itemPath);
  const hasChildren = !knownLeaf && item.hasChildren !== false;
  const exactActive = samePath(itemPath, activePath);
  const ancestorActive = !exactActive && pathInsideFolder(activePath, itemPath);
  const classes = [
    "tree-node",
    exactActive ? "active" : "",
    ancestorActive ? "contains-active" : "",
    expanded ? "expanded" : "",
    loading ? "loading" : ""
  ]
    .filter(Boolean)
    .join(" ");
  const style = `--tree-depth:${Math.min(depth, 12)}`;
  const toggle = hasChildren
    ? `<button class="tree-toggle" data-tree-toggle="${escapeHtml(itemPath)}" title="${
        expanded ? "Collapse folder" : "Expand folder"
      }" aria-label="${expanded ? "Collapse folder" : "Expand folder"}">${expanded ? "-" : "+"}</button>`
    : `<span class="tree-spacer"></span>`;
  const childMarkup = expanded
    ? `<div class="tree-children">${renderFolderTreeChildren(itemPath, depth + 1)}</div>`
    : "";
  return `<div class="${classes}" style="${style}">
    <div class="tree-row">
      ${toggle}
      <button class="tree-main" data-tree-open="${escapeHtml(itemPath)}" title="${escapeHtml(itemPath)}">
        <span class="tree-code">${escapeHtml(navGlyph(item.kind || "folder"))}</span>
        <span class="tree-name">${escapeHtml(item.name || labelForPath(itemPath))}</span>
      </button>
      <button class="tree-other" data-tree-open-other="${escapeHtml(
        itemPath
      )}" title="Open in other pane" aria-label="Open in other pane">&gt;</button>
    </div>
    ${childMarkup}
  </div>`;
}

function renderFolderTreeChildren(itemPath, depth) {
  if (app.folderTree.loading.has(normalizedPathKey(itemPath))) {
    return `<div class="tree-message" style="--tree-depth:${Math.min(depth, 12)}">Loading...</div>`;
  }
  const node = folderTreeNodeFor(itemPath);
  if (node?.error) {
    return `<div class="tree-message error" style="--tree-depth:${Math.min(depth, 12)}">${escapeHtml(
      node.error
    )}</div>`;
  }
  const entries = node?.entries || [];
  if (!entries.length) {
    return `<div class="tree-message" style="--tree-depth:${Math.min(depth, 12)}">No subfolders</div>`;
  }
  const children = entries.map((entry) => renderFolderTreeNode(entry, depth)).join("");
  const note = node.truncated
    ? `<div class="tree-message" style="--tree-depth:${Math.min(depth, 12)}">Showing first ${entries.length} folders</div>`
    : "";
  return `${children}${note}`;
}

async function loadFolderTreeChildren(itemPath, options = {}) {
  const key = normalizedPathKey(itemPath);
  if (!options.force && app.folderTree.nodes.has(key)) {
    renderFolderTree();
    return folderTreeNodeFor(itemPath);
  }
  app.folderTree.loading.add(key);
  renderFolderTree();
  try {
    const query = new URLSearchParams({
      path: itemPath,
      limit: "80",
      showHidden: showHiddenEntriesEnabled() ? "true" : "false",
      includeStats: "false",
      includeChildState: "false"
    });
    const node = await request(`/api/tree?${query}`);
    app.folderTree.nodes.set(key, node);
    if ((node.entries || []).length) {
      app.folderTree.leafPaths.delete(key);
    } else {
      app.folderTree.leafPaths.add(key);
      app.folderTree.expanded.delete(key);
    }
    return node;
  } catch (error) {
    app.folderTree.nodes.set(key, { path: itemPath, entries: [], error: error.message });
    return null;
  } finally {
    app.folderTree.loading.delete(key);
    renderFolderTree();
  }
}

async function toggleFolderTree(itemPath) {
  const key = normalizedPathKey(itemPath);
  if (app.folderTree.expanded.has(key)) {
    app.folderTree.expanded.delete(key);
    renderFolderTree();
    return;
  }
  app.folderTree.expanded.add(key);
  await loadFolderTreeChildren(itemPath);
}

async function refreshFolderTree() {
  app.folderTree.nodes.clear();
  app.folderTree.loading.clear();
  app.folderTree.leafPaths.clear();
  renderFolderTree();
  const activePath = tabOf(app.activePane)?.path;
  if (activePath) {
    await revealPathInFolderTree(activePath);
  }
  showToast("Folder tree refreshed");
}

async function revealPathInFolderTree(itemPath) {
  const roots = folderTreeRoots();
  const match = roots.find((root) => pathInsideFolder(itemPath, root.path));
  if (!match) {
    renderFolderTree();
    return;
  }
  const parts = pathSegmentsBetween(match.path, itemPath);
  let current = match.path;
  app.folderTree.expanded.add(normalizedPathKey(current));
  await loadFolderTreeChildren(current);
  for (const part of parts) {
    const node = folderTreeNodeFor(current);
    const child = node?.entries?.find((entry) => entry.name.toLowerCase() === part.toLowerCase());
    if (!child) {
      break;
    }
    current = child.path;
    app.folderTree.expanded.add(normalizedPathKey(current));
    await loadFolderTreeChildren(current);
  }
  renderFolderTree();
}

function pathSegmentsBetween(rootPath, itemPath) {
  const root = String(rootPath || "").replace(/[\\/]+$/, "");
  const target = String(itemPath || "").replace(/[\\/]+$/, "");
  if (!target.toLowerCase().startsWith(root.toLowerCase())) {
    return [];
  }
  return target
    .slice(root.length)
    .replace(/^[\\/]+/, "")
    .split(/[\\/]+/)
    .filter(Boolean);
}

function rememberLocation(itemPath) {
  if (!app.state || !itemPath) {
    return;
  }
  const recentLocations = app.state.recentLocations || [];
  const key = normalizedPathKey(itemPath);
  app.state.recentLocations = [
    {
      name: labelForPath(itemPath),
      path: itemPath,
      visitedAt: new Date().toISOString()
    },
    ...recentLocations.filter((item) => normalizedPathKey(item.path) !== key)
  ].slice(0, 16);
}

function renderSavedCommandStrip() {
  const strip = document.getElementById("saved-command-strip");
  const commands = (app.state?.commands || []).filter((command) => command.showInToolbar);
  const scripts = (app.state?.scripts || []).filter((snippet) => snippet.showInToolbar);
  const commandButtons = commands
    .map(
      (command) =>
        `<button class="saved-command-button" data-run-tool="${escapeHtml(command.id)}" title="${escapeHtml(
          command.description || command.name
        )}">${escapeHtml(command.name)}</button>`
    );
  const scriptButtons = scripts.map(
    (snippet) =>
      `<button class="saved-command-button script-command-button" data-run-script="${escapeHtml(
        snippet.id
      )}" title="${escapeHtml(snippet.description || snippet.name)}">JS ${escapeHtml(snippet.name)}</button>`
  );
  strip.innerHTML = [...commandButtons, ...scriptButtons].join("");
  scheduleDockOverflowUpdate();
}

function isInlineRenaming(paneName, entry) {
  return Boolean(app.inlineRename?.paneName === paneName && samePath(app.inlineRename.path, entry.path));
}

function inlineRenameMarkup(entry, paneName) {
  return `<input class="inline-rename-input" data-inline-rename data-inline-rename-pane="${escapeHtml(
    paneName
  )}" data-inline-rename-path="${escapeHtml(entry.path)}" value="${escapeHtml(
    app.inlineRename?.value || entry.name
  )}" aria-label="Rename ${escapeHtml(entry.name)}" spellcheck="false" />`;
}

function entryNameMarkup(entry, tab, paneName) {
  if (isInlineRenaming(paneName, entry)) {
    return inlineRenameMarkup(entry, paneName);
  }
  if (!tab.searchMode) {
    return escapeHtml(entry.name);
  }
  return `${escapeHtml(entry.name)}<small title="${escapeHtml(entry.parent || "")}">${escapeHtml(
    entry.parent || ""
  )}</small>${
    entry.matchSnippet ? `<small class="search-result-snippet">${escapeHtml(entry.matchSnippet)}</small>` : ""
  }`;
}

function entryNameBlock(entry, tab, paneName) {
  return `<span class="entry-name-text">${entryNameMarkup(entry, tab, paneName)}</span>${labelBadgeMarkup(
    entry.label
  )}`;
}

function thumbnailMarkup(entry, glyph) {
  if (!entry.unavailable && entry.kind === "Image" && entry.isFile) {
    return `<img class="tile-thumb-image lazy" data-thumb-src="${escapeHtml(rawFileUrl(entry))}" alt="" loading="lazy" decoding="async">`;
  }
  return `<span class="glyph tile-glyph ${glyph.className}">${escapeHtml(glyph.text)}</span>`;
}

function detailCellMarkup(column, entry, tab, hasLabelColumn, paneName) {
  const glyph = glyphFor(entry);
  if (column.id === "name") {
    const badge = hasLabelColumn ? "" : labelBadgeMarkup(entry.label);
    return `<div class="file-cell name-cell">
      <span class="glyph ${glyph.className}">${escapeHtml(glyph.text)}</span>
      <span class="entry-name-wrap">${entryNameMarkup(entry, tab, paneName)}${badge}</span>
    </div>`;
  }
  if (column.id === "kind") {
    return `<div class="file-cell">${escapeHtml(entry.kind)}</div>`;
  }
  if (column.id === "extension") {
    return `<div class="file-cell">${escapeHtml(entry.extension || "")}</div>`;
  }
  if (column.id === "size") {
    return `<div class="file-cell numeric-cell size-cell${entrySizeClass(entry)}" title="${escapeHtml(
      entrySizeTitle(entry)
    )}">${escapeHtml(entrySizeText(entry))}</div>`;
  }
  if (column.id === "dimensions") {
    return `<div class="file-cell numeric-cell dimensions-cell" title="${escapeHtml(
      imageDimensionsTitle(entry)
    )}">${escapeHtml(imageDimensionsText(entry))}</div>`;
  }
  if (column.id === "attributes") {
    return `<div class="file-cell attr-cell" title="${escapeHtml(attributeTitle(entry))}">${escapeHtml(
      attributeText(entry)
    )}</div>`;
  }
  if (column.id === "linkType") {
    return `<div class="file-cell link-cell" title="${escapeHtml(linkTitle(entry))}">${escapeHtml(
      linkTypeText(entry)
    )}</div>`;
  }
  if (column.id === "linkTarget") {
    const target = linkTargetText(entry);
    return `<div class="file-cell path-cell link-target-cell" title="${escapeHtml(target)}">${escapeHtml(
      target
    )}</div>`;
  }
  if (column.id === "modified") {
    return `<div class="file-cell">${formatDate(entry.modified)}</div>`;
  }
  if (column.id === "created") {
    return `<div class="file-cell">${formatDate(entry.created)}</div>`;
  }
  if (column.id === "accessed") {
    return `<div class="file-cell">${formatDate(entry.accessed)}</div>`;
  }
  if (column.id === "label") {
    return `<div class="file-cell label-cell">${labelBadgeMarkup(entry.label)}</div>`;
  }
  if (column.id === "notes") {
    const notes = labelNotesText(entry);
    return `<div class="file-cell notes-cell" title="${escapeHtml(notes)}">${escapeHtml(notes)}</div>`;
  }
  if (column.id === "parent") {
    return `<div class="file-cell path-cell" title="${escapeHtml(entry.parent || "")}">${escapeHtml(
      entry.parent || ""
    )}</div>`;
  }
  return `<div class="file-cell"></div>`;
}

function entryStateClasses(entry) {
  return [
    entry.unavailable ? "unavailable" : "",
    entry.hidden ? "is-hidden" : "",
    entry.system ? "is-system" : "",
    entry.readonly ? "is-readonly" : "",
    linkTypeText(entry) ? "is-link" : "",
    clipboardHasPath(entry.path) ? "cut" : ""
  ]
    .filter(Boolean)
    .map((className) => ` ${className}`)
    .join("");
}

function entryDomKey(entryPath) {
  return normalizedPathKey(entryPath);
}

function entryDomKeyAttribute(entryPath) {
  return `data-entry-key="${escapeHtml(entryDomKey(entryPath))}"`;
}

function stableIdHash(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function entryDomId(paneName, entryPath) {
  return `entry-${paneName}-${stableIdHash(entryDomKey(entryPath))}`;
}

function entryAccessibleName(entry) {
  const parts = [
    entry.isDirectory ? "Folder" : "File",
    entry.name,
    entryMetaText(entry),
    entry.size && entry.isFile ? formatSize(entry.size) : "",
    entry.modified ? `modified ${formatDate(entry.modified)}` : "",
    entry.labelName || entry.label?.name || "",
    labelNotesText(entry)
  ].filter(Boolean);
  return parts.join(", ");
}

function renderEntryRow(entry, paneName, tab) {
  const columns = columnsForTab(tab);
  const hasLabelColumn = columns.some((column) => column.id === "label");
  const isSelected = tab.selected.has(entry.path);
  const selected = isSelected ? " selected" : "";
  const focused = tab.focusedPath === entry.path ? " focused" : "";
  const stateClasses = entryStateClasses(entry);
  const accessibleName = entryAccessibleName(entry);
  return `<div class="file-row${selected}${focused}${stateClasses}" role="option" aria-selected="${
    isSelected ? "true" : "false"
  }" aria-label="${escapeHtml(accessibleName)}" id="${entryDomId(paneName, entry.path)}" data-entry-path="${escapeHtml(
    entry.path
  )}" data-entry-kind="${entry.isDirectory ? "directory" : "file"}" ${entryDomKeyAttribute(entry.path)} data-pane="${paneName}" draggable="true">
    ${columns.map((column) => detailCellMarkup(column, entry, tab, hasLabelColumn, paneName)).join("")}
  </div>`;
}

function renderCompactEntry(entry, paneName, tab) {
  const glyph = glyphFor(entry);
  const isSelected = tab.selected.has(entry.path);
  const selected = isSelected ? " selected" : "";
  const focused = tab.focusedPath === entry.path ? " focused" : "";
  const stateClasses = entryStateClasses(entry);
  const accessibleName = entryAccessibleName(entry);
  return `<div class="file-row compact-row${selected}${focused}${stateClasses}" role="option" aria-selected="${
    isSelected ? "true" : "false"
  }" aria-label="${escapeHtml(accessibleName)}" id="${entryDomId(paneName, entry.path)}" data-entry-path="${escapeHtml(
    entry.path
  )}" data-entry-kind="${entry.isDirectory ? "directory" : "file"}" ${entryDomKeyAttribute(entry.path)} data-pane="${paneName}" draggable="true">
    <span class="glyph ${glyph.className}">${escapeHtml(glyph.text)}</span>
    <span class="compact-name">${entryNameBlock(entry, tab, paneName)}</span>
    <span class="compact-meta" title="${escapeHtml(entrySizeTitle(entry))}">${escapeHtml(entryMetaText(entry))}</span>
  </div>`;
}

function renderTileEntry(entry, paneName, tab) {
  const glyph = glyphFor(entry);
  const isSelected = tab.selected.has(entry.path);
  const selected = isSelected ? " selected" : "";
  const focused = tab.focusedPath === entry.path ? " focused" : "";
  const stateClasses = entryStateClasses(entry);
  const accessibleName = entryAccessibleName(entry);
  return `<div class="file-tile${selected}${focused}${stateClasses}" role="option" aria-selected="${
    isSelected ? "true" : "false"
  }" aria-label="${escapeHtml(accessibleName)}" id="${entryDomId(paneName, entry.path)}" data-entry-path="${escapeHtml(
    entry.path
  )}" data-entry-kind="${entry.isDirectory ? "directory" : "file"}" ${entryDomKeyAttribute(entry.path)} data-pane="${paneName}" title="${escapeHtml(entry.path)}" draggable="true">
    <div class="tile-thumb">${thumbnailMarkup(entry, glyph)}</div>
    <div class="tile-copy">
      <strong>${entryNameMarkup(entry, tab, paneName)}</strong>
      ${labelBadgeMarkup(entry.label)}
      <small title="${escapeHtml(entrySizeTitle(entry))}">${escapeHtml(entryMetaText(entry))}</small>
    </div>
  </div>`;
}

function applyColumnGrid(paneName, tab = tabOf(paneName)) {
  const grid = columnGridFor(tab);
  const paneElement = document.querySelector(`.pane[data-pane="${paneName}"]`);
  paneElement?.querySelector(".file-head")?.style.setProperty("--file-columns", grid);
  paneElement?.querySelector("[data-list]")?.style.setProperty("--file-columns", grid);
}

function renderFileHead(paneName, tab) {
  const head = document.querySelector(`.pane[data-pane="${paneName}"] .file-head`);
  applyColumnGrid(paneName, tab);
  head.innerHTML = columnsForTab(tab)
    .map((column) => {
      const active = tab.sortKey === column.sortKey ? " active" : "";
      const direction = active ? (tab.sortDir === "asc" ? " A-Z" : " Z-A") : "";
      return `<button class="${active}" data-sort="${escapeHtml(column.sortKey)}" data-column-id="${escapeHtml(
        column.id
      )}" data-pane="${paneName}" title="${escapeHtml(column.title)}">
        <span class="column-title">${escapeHtml(column.title)}${direction}</span>
        <span class="column-resize-grip" data-column-resize="${escapeHtml(column.id)}" data-pane="${paneName}" title="Resize ${escapeHtml(
          column.title
        )}"></span>
      </button>`;
    })
    .join("");
}

function columnHeaderButton(paneName, columnId) {
  const selector = `.pane[data-pane="${paneName}"] .file-head [data-column-id="${CSS.escape(columnId)}"]`;
  return document.querySelector(selector);
}

function columnVisibleWidth(paneName, columnId) {
  const rect = columnHeaderButton(paneName, columnId)?.getBoundingClientRect();
  return rect?.width || columnDefaultPixelWidth(columnId);
}

function beginColumnResize(event, paneName, columnId) {
  if (event.button !== 0 || !isPaneName(paneName) || !columnDefById(columnId)) {
    return false;
  }
  const tab = tabOf(paneName);
  const startWidth = normalizeColumnWidth(columnId, tab.columnWidths?.[columnId] || columnVisibleWidth(paneName, columnId));
  app.columnResize = {
    paneName,
    columnId,
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth,
    currentWidth: startWidth,
    handle: event.target.closest("[data-column-resize]"),
    frame: null
  };
  app.columnResize.handle?.setPointerCapture?.(event.pointerId);
  app.columnResize.handle?.classList.add("dragging");
  document.body.classList.add("resizing-columns");
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function applyColumnResizeDraft(session, width) {
  const tab = tabOf(session.paneName);
  tab.columnWidths = {
    ...normalizeColumnWidths(tab.columnWidths),
    [session.columnId]: normalizeColumnWidth(session.columnId, width)
  };
  session.currentWidth = tab.columnWidths[session.columnId];
  if (session.frame) {
    return;
  }
  session.frame = requestAnimationFrame(() => {
    const active = app.columnResize;
    if (!active) {
      return;
    }
    active.frame = null;
    applyColumnGrid(active.paneName);
  });
}

function updateColumnResize(event) {
  const session = app.columnResize;
  if (!session || event.pointerId !== session.pointerId) {
    return;
  }
  applyColumnResizeDraft(session, session.startWidth + event.clientX - session.startX);
  event.preventDefault();
}

function finishColumnResize(event) {
  const session = app.columnResize;
  if (!session || (event.pointerId !== undefined && event.pointerId !== session.pointerId)) {
    return;
  }
  if (session.frame) {
    cancelAnimationFrame(session.frame);
  }
  applyColumnGrid(session.paneName);
  session.handle?.classList.remove("dragging");
  session.handle?.releasePointerCapture?.(session.pointerId);
  app.columnResize = null;
  document.body.classList.remove("resizing-columns");
  renderColumnsDialog();
  scheduleStateSave();
}

function columnValueText(columnId, entry) {
  if (columnId === "name") return entry.name || labelForPath(entry.path);
  if (columnId === "kind") return entry.kind || "";
  if (columnId === "extension") return entry.extension || "";
  if (columnId === "size") return entrySizeText(entry);
  if (columnId === "dimensions") return imageDimensionsText(entry);
  if (columnId === "attributes") return attributeText(entry);
  if (columnId === "linkType") return linkTypeText(entry);
  if (columnId === "linkTarget") return linkTargetText(entry);
  if (columnId === "modified") return formatDate(entry.modified);
  if (columnId === "created") return formatDate(entry.created);
  if (columnId === "accessed") return formatDate(entry.accessed);
  if (columnId === "label") return entry.label?.name || "";
  if (columnId === "notes") return labelNotesText(entry);
  if (columnId === "parent") return entry.parent || parentPathOf(entry.path);
  return "";
}

function columnMeasureContext() {
  if (!app.columnMeasureCanvas) {
    app.columnMeasureCanvas = document.createElement("canvas");
  }
  const context = app.columnMeasureCanvas.getContext("2d");
  context.font = getComputedStyle(document.body).font || "12px Segoe UI";
  return context;
}

function measureColumnText(text) {
  return columnMeasureContext().measureText(String(text || "")).width;
}

function autosizeColumnWidth(paneName, columnId) {
  const column = columnDefById(columnId);
  if (!column) {
    return null;
  }
  const entries = visibleEntries(paneName).slice(0, columnAutosizeSampleLimit);
  let width = measureColumnText(column.title) + 42;
  for (const entry of entries) {
    const padding = columnId === "name" ? 58 : 28;
    width = Math.max(width, measureColumnText(columnValueText(columnId, entry)) + padding);
  }
  return normalizeColumnWidth(columnId, width);
}

function setColumnWidth(paneName, columnId, width, options = {}) {
  if (!isPaneName(paneName) || !columnDefById(columnId)) {
    return false;
  }
  const tab = tabOf(paneName);
  tab.columnWidths = {
    ...normalizeColumnWidths(tab.columnWidths),
    [columnId]: normalizeColumnWidth(columnId, width)
  };
  applyColumnGrid(paneName, tab);
  if (options.save !== false) {
    scheduleStateSave();
  }
  return true;
}

function autosizeColumn(paneName, columnId) {
  const width = autosizeColumnWidth(paneName, columnId);
  if (!width) {
    return false;
  }
  setColumnWidth(paneName, columnId, width);
  showToast(`${columnDefById(columnId).title} autosized`);
  return true;
}

function autosizeAllColumns(paneName) {
  const tab = tabOf(paneName);
  const widths = {};
  for (const column of columnsForTab(tab)) {
    widths[column.id] = autosizeColumnWidth(paneName, column.id) || columnDefaultPixelWidth(column.id);
  }
  tab.columnWidths = normalizeColumnWidths(widths);
  applyColumnGrid(paneName, tab);
  scheduleStateSave();
  renderColumnsDialog();
  showToast("Columns autosized");
}

function resetColumnWidths(paneName) {
  const tab = tabOf(paneName);
  tab.columnWidths = {};
  applyColumnGrid(paneName, tab);
  scheduleStateSave();
  renderColumnsDialog();
  showToast("Column widths reset");
}

async function applyColumnPreset(paneName, presetId) {
  const preset = columnPresetDefinitions.find((item) => item.id === presetId) || columnPresetDefinitions[0];
  const tab = tabOf(paneName);
  tab.columns = normalizeColumns(preset.columns);
  tab.columnWidths = normalizeColumnWidths(preset.widths);
  const visibleSorts = new Set(columnsForTab(tab).map((column) => column.sortKey));
  if (!visibleSorts.has(tab.sortKey)) {
    tab.sortKey = "name";
    tab.sortDir = "asc";
  }
  if (tabNeedsUnloadedMetadata(tab)) {
    await refreshPane(paneName, { preserveSelection: true, save: false, silent: true });
  } else {
    renderPane(paneName);
  }
  scheduleStateSave();
  renderColumnsDialog();
  renderFolderFormats();
  renderDisplayPresets();
  showToast(`${preset.name} columns`);
}

async function resetColumnsToDefault(paneName) {
  await applyColumnPreset(paneName, "default");
}

async function toggleColumn(paneName, columnId) {
  const column = columnDefById(columnId);
  if (!column) {
    return false;
  }
  const tab = tabOf(paneName);
  const columns = normalizeColumns(tab.columns);
  const next = columns.includes(columnId)
    ? columns.filter((id) => id !== columnId || column.required)
    : [...columns, columnId];
  tab.columns = normalizeColumns(next);
  const visibleSorts = new Set(columnsForTab(tab).map((item) => item.sortKey));
  if (!visibleSorts.has(tab.sortKey)) {
    tab.sortKey = "name";
    tab.sortDir = "asc";
  }
  if (tabNeedsUnloadedMetadata(tab)) {
    await refreshPane(paneName, { preserveSelection: true, save: false, silent: true });
  } else {
    renderPane(paneName);
  }
  scheduleStateSave();
  renderColumnsDialog();
  showToast(columns.includes(columnId) ? `${column.title} hidden` : `${column.title} shown`);
  return true;
}

async function sortPaneByColumn(paneName, sortKey, direction = null) {
  const tab = tabOf(paneName);
  if (direction) {
    tab.sortKey = sortKey;
    tab.sortDir = direction === "desc" ? "desc" : "asc";
  } else if (tab.sortKey === sortKey) {
    tab.sortDir = tab.sortDir === "asc" ? "desc" : "asc";
  } else {
    tab.sortKey = sortKey;
    tab.sortDir = "asc";
  }
  if (tabNeedsUnloadedMetadata(tab)) {
    await refreshPane(paneName, { preserveSelection: true, save: false, silent: true });
  } else {
    renderPane(paneName);
  }
  scheduleStateSave();
}

function fileRenderLimits(viewMode) {
  if (viewMode === "tiles") {
    return { initial: 180, chunk: 180 };
  }
  if (viewMode === "compact") {
    return { initial: 900, chunk: 900 };
  }
  return { initial: 650, chunk: 650 };
}

function renderEntriesMarkup(entries, paneName, tab, renderer, start = 0, end = entries.length) {
  return entries
    .slice(start, end)
    .map((entry) => renderer(entry, paneName, tab))
    .join("");
}

function renderFileRenderProgress(rendered, total) {
  return `<div class="file-render-progress" data-render-progress>
    <strong>${rendered.toLocaleString()}</strong>
    <span>/ ${total.toLocaleString()} rendered</span>
  </div>`;
}

function virtualRowHeight(viewMode) {
  return viewMode === "compact" ? 30 : 34;
}

function shouldVirtualizeFileList(tab, entries) {
  return ["details", "compact", "tiles"].includes(tab.viewMode) && entries.length > virtualRenderThreshold;
}

function virtualListMetrics(tab, list, entriesLength) {
  if (tab.viewMode !== "tiles") {
    return {
      mode: "rows",
      columns: 1,
      rowHeight: virtualRowHeight(tab.viewMode),
      itemHeight: virtualRowHeight(tab.viewMode),
      topPadding: 0,
      bottomPadding: 0,
      gap: 0,
      totalHeight: entriesLength * virtualRowHeight(tab.viewMode)
    };
  }
  const availableWidth = Math.max(virtualTileMinWidth, (list?.clientWidth || virtualTileMinWidth) - virtualTilePadding * 2);
  const columns = Math.max(
    1,
    Math.floor((availableWidth + virtualTileGap) / (virtualTileMinWidth + virtualTileGap))
  );
  const rowCount = Math.ceil(entriesLength / columns);
  const rowHeight = virtualTileHeight + virtualTileGap;
  return {
    mode: "tiles",
    columns,
    rowHeight,
    itemHeight: virtualTileHeight,
    topPadding: virtualTilePadding,
    bottomPadding: virtualTilePadding,
    gap: virtualTileGap,
    totalHeight:
      virtualTilePadding * 2 +
      rowCount * virtualTileHeight +
      Math.max(0, rowCount - 1) * virtualTileGap
  };
}

function clearVirtualFileList(paneName, list = null) {
  const frame = app.virtualRenderFrames[paneName];
  if (frame) {
    cancelAnimationFrame(frame);
  }
  app.virtualRenderFrames[paneName] = null;
  app.virtualLists[paneName] = null;
  if (list) {
    list.onscroll = null;
  }
}

function scheduleVirtualFileRender(paneName) {
  if (app.virtualRenderFrames[paneName]) {
    return;
  }
  app.virtualRenderFrames[paneName] = requestAnimationFrame(() => {
    app.virtualRenderFrames[paneName] = null;
    renderVirtualFileWindow(paneName);
  });
}

function renderVirtualFileWindow(paneName, force = false) {
  const state = app.virtualLists[paneName];
  const list = document.querySelector(`[data-list="${paneName}"]`);
  if (!state || !list || app.renderTokens[paneName] !== state.token) {
    return;
  }
  const windowElement = list.querySelector("[data-virtual-window]");
  if (!windowElement) {
    return;
  }
  const metrics = virtualListMetrics(state.tab, list, state.entries.length);
  const scrollTop = Math.max(0, list.scrollTop - metrics.topPadding);
  const visibleRows = Math.ceil((list.clientHeight || metrics.rowHeight * 16) / metrics.rowHeight);
  const startRow = Math.max(0, Math.floor(scrollTop / metrics.rowHeight) - virtualOverscanRows);
  const endRow = Math.ceil(state.entries.length / metrics.columns);
  const rowEnd = Math.min(endRow, startRow + visibleRows + virtualOverscanRows * 2);
  const start = startRow * metrics.columns;
  const end = Math.min(state.entries.length, rowEnd * metrics.columns);
  if (
    !force &&
    start === state.start &&
    end === state.end &&
    metrics.columns === state.columns &&
    metrics.totalHeight === state.totalHeight
  ) {
    return;
  }
  state.start = start;
  state.end = end;
  state.columns = metrics.columns;
  state.rowHeight = metrics.rowHeight;
  state.itemHeight = metrics.itemHeight;
  state.totalHeight = metrics.totalHeight;
  list.querySelector(".virtual-spacer")?.style.setProperty("height", `${metrics.totalHeight}px`);
  windowElement.style.transform = `translateY(${metrics.topPadding + startRow * metrics.rowHeight}px)`;
  windowElement.style.setProperty("--virtual-columns", String(metrics.columns));
  if (state.tab.viewMode === "tiles") {
    unobserveLazyThumbnailImages(paneName, windowElement);
  }
  windowElement.innerHTML = renderEntriesMarkup(state.entries, paneName, state.tab, state.renderer, start, end);
  if (state.tab.viewMode === "tiles") {
    hydrateLazyThumbnailImages(paneName, list, [
      ...windowElement.querySelectorAll(".tile-thumb-image[data-thumb-src]")
    ]);
  }
}

function renderVirtualFileList(paneName, tab, entries, renderer, renderToken, list) {
  const metrics = virtualListMetrics(tab, list, entries.length);
  clearVirtualFileList(paneName, list);
  app.virtualLists[paneName] = {
    entries,
    renderer,
    tab,
    rowHeight: metrics.rowHeight,
    itemHeight: metrics.itemHeight,
    columns: metrics.columns,
    totalHeight: metrics.totalHeight,
    token: renderToken,
    start: -1,
    end: -1
  };
  list.classList.add("virtualized");
  list.innerHTML = `<div class="virtual-spacer" style="height: ${metrics.totalHeight}px;">
    <div class="virtual-window" data-virtual-window></div>
  </div>`;
  list.onscroll = () => scheduleVirtualFileRender(paneName);
  renderVirtualFileWindow(paneName, true);
}

function disconnectThumbnailObserver(paneName) {
  app.thumbnailObservers[paneName]?.disconnect?.();
  app.thumbnailObservers[paneName] = null;
}

function loadTileThumbnail(image) {
  const source = image?.dataset?.thumbSrc;
  if (!source) {
    return;
  }
  image.classList.add("loading");
  image.addEventListener("load", () => {
    image.classList.remove("loading");
    image.classList.add("loaded");
  }, { once: true });
  image.addEventListener("error", () => {
    image.classList.remove("loading");
    image.classList.add("error");
  }, { once: true });
  image.src = source;
  image.removeAttribute("data-thumb-src");
}

function thumbnailObserverForPane(paneName, list) {
  if (!("IntersectionObserver" in window)) {
    return null;
  }
  if (!app.thumbnailObservers[paneName]) {
    const observer = new IntersectionObserver((items) => {
      for (const item of items) {
        if (!item.isIntersecting) {
          continue;
        }
        observer.unobserve(item.target);
        loadTileThumbnail(item.target);
      }
    }, {
      root: list,
      rootMargin: "720px 0px",
      threshold: 0.01
    });
    app.thumbnailObservers[paneName] = observer;
  }
  return app.thumbnailObservers[paneName];
}

function hydrateLazyThumbnails(paneName) {
  const list = document.querySelector(`[data-list="${paneName}"]`);
  if (!list || !list.classList.contains("view-tiles")) {
    disconnectThumbnailObserver(paneName);
    return;
  }
  hydrateLazyThumbnailImages(paneName, list, [...list.querySelectorAll(".tile-thumb-image[data-thumb-src]")]);
}

function hydrateLazyThumbnailImages(paneName, list, images) {
  if (!images.length) {
    return;
  }
  const observer = thumbnailObserverForPane(paneName, list);
  if (!observer) {
    images.forEach(loadTileThumbnail);
    return;
  }
  images.forEach((image) => observer.observe(image));
}

function unobserveLazyThumbnailImages(paneName, root) {
  const observer = app.thumbnailObservers[paneName];
  if (!observer || !root) {
    return;
  }
  root.querySelectorAll(".tile-thumb-image[data-thumb-src]").forEach((image) => observer.unobserve(image));
}

function appendEntriesMarkup(list, html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const images = [...template.content.querySelectorAll(".tile-thumb-image[data-thumb-src]")];
  list.append(template.content);
  return images;
}

function scheduleProgressiveFileRender(paneName, token, entries, renderer, startIndex, chunkSize) {
  const list = document.querySelector(`[data-list="${paneName}"]`);
  const tab = tabOf(paneName);
  if (!list || app.renderTokens[paneName] !== token) {
    return;
  }
  const nextIndex = Math.min(startIndex + chunkSize, entries.length);
  const progress = list.querySelector("[data-render-progress]");
  progress?.remove();
  const lazyImages = appendEntriesMarkup(
    list,
    renderEntriesMarkup(entries, paneName, tab, renderer, startIndex, nextIndex)
  );
  hydrateLazyThumbnailImages(paneName, list, lazyImages);
  const focusedPath = tab.focusedPath;
  const focusedInChunk =
    focusedPath && entries.slice(startIndex, nextIndex).some((entry) => samePath(entry.path, focusedPath));
  if (focusedInChunk) {
    scrollFocusedEntryIntoView(paneName);
  }
  if (nextIndex < entries.length) {
    list.insertAdjacentHTML("beforeend", renderFileRenderProgress(nextIndex, entries.length));
    requestAnimationFrame(() => scheduleProgressiveFileRender(paneName, token, entries, renderer, nextIndex, chunkSize));
  }
}

function renderPane(paneName) {
  const pane = panes[paneName];
  const tab = tabOf(paneName);
  const paneElement = document.querySelector(`[data-pane="${paneName}"]`);
  paneElement.classList.toggle("active", app.activePane === paneName);
  for (const mode of ["details", "compact", "tiles"]) {
    paneElement.classList.toggle(`view-${mode}`, tab.viewMode === mode);
  }
  paneElement.classList.toggle("virtual-zip", tab.virtualMode === "zip");

  const tabsElement = document.querySelector(`[data-tabs="${paneName}"]`);
  tabsElement.innerHTML =
    pane.tabs
      .map((item, index) => {
        const active = index === pane.activeTab ? " active" : "";
        const locked = item.locked ? " locked" : "";
        const lockTitle = item.locked ? "Unlock tab" : "Lock tab";
        const closeButton =
          pane.tabs.length > 1
            ? `<button class="tab-close" data-close-tab="${index}" data-pane="${paneName}" title="Close tab" aria-label="Close tab">&times;</button>`
            : `<span></span>`;
        return `<div class="tab${active}${locked}" data-tab-shell="${index}" data-pane="${paneName}" draggable="true" title="${escapeHtml(item.path)}">
          <button class="tab-label" data-tab="${index}" data-pane="${paneName}">
            <span>${escapeHtml(item.title || labelForPath(item.path))}</span>
          </button>
          <button class="tab-lock${item.locked ? " active" : ""}" data-lock-tab="${index}" data-pane="${paneName}" title="${lockTitle}" aria-label="${lockTitle}"><span class="tab-lock-glyph" aria-hidden="true"></span></button>
          ${closeButton}
        </div>`;
      })
      .join("") +
    `<button class="new-tab" data-new-tab="${paneName}" title="New tab" aria-label="New tab">+</button>
     ${paneActivityMarkup(paneName)}`;

  document.querySelector(`[data-path-input="${paneName}"]`).value = tab.path;
  const breadcrumbs = document.querySelector(`[data-breadcrumbs="${paneName}"]`);
  if (breadcrumbs) {
    breadcrumbs.innerHTML = renderBreadcrumbs(paneName, tab.path);
  }
  document.querySelector(`[data-filter="${paneName}"]`).value = tab.filter;
  const kindFilter = document.querySelector(`[data-kind-filter="${paneName}"]`);
  if (kindFilter) {
    kindFilter.innerHTML = renderKindFilterOptions(tab.kindFilter || "all");
  }
  const labelFilter = document.querySelector(`[data-label-filter="${paneName}"]`);
  if (labelFilter) {
    labelFilter.innerHTML = renderLabelFilterOptions(tab.labelFilter || "all");
  }
  document.querySelectorAll(`[data-view-mode][data-pane="${paneName}"]`).forEach((button) => {
    button.classList.toggle("active", button.dataset.viewMode === tab.viewMode);
  });
  updateDualPaneActionChrome();
  renderPaneActivity(paneName);
  renderFileHead(paneName, tab);

  const list = document.querySelector(`[data-list="${paneName}"]`);
  disconnectThumbnailObserver(paneName);
  clearVirtualFileList(paneName, list);
  list.className = `file-list view-${tab.viewMode}`;
  list.style.setProperty("--file-columns", columnGridFor(tab));
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-multiselectable", "true");
  list.setAttribute("aria-label", `${paneName === "left" ? "Left" : "Right"} file list`);
  if (tab.focusedPath) {
    list.setAttribute("aria-activedescendant", entryDomId(paneName, tab.focusedPath));
  } else {
    list.removeAttribute("aria-activedescendant");
  }
  const renderToken = (app.renderTokens[paneName] || 0) + 1;
  app.renderTokens[paneName] = renderToken;
  const visibleData = visibleEntryData(tab);
  const entries = visibleData.entries;
  if (!entries.length) {
    const access = tab.accessError;
    list.innerHTML = access
      ? `<div class="empty-state access-state">
          <strong>${escapeHtml(access.code || "Access denied")}</strong>
          <span>${escapeHtml(access.message || "Folder cannot be read.")}</span>
          <small>${escapeHtml(access.path || tab.path)}</small>
        </div>`
      : `<div class="empty-state">No items</div>`;
    if (paneName === app.activePane) {
      updateSelectionReadout();
    }
    return;
  }

  const renderer =
    tab.viewMode === "tiles" ? renderTileEntry : tab.viewMode === "compact" ? renderCompactEntry : renderEntryRow;
  if (shouldVirtualizeFileList(tab, entries)) {
    renderVirtualFileList(paneName, tab, entries, renderer, renderToken, list);
    if (paneName === app.activePane) {
      updateSelectionReadout();
    }
    return;
  }
  const limits = fileRenderLimits(tab.viewMode);
  const initialLimit = Math.min(limits.initial, entries.length);
  list.innerHTML =
    renderEntriesMarkup(entries, paneName, tab, renderer, 0, initialLimit) +
    (initialLimit < entries.length ? renderFileRenderProgress(initialLimit, entries.length) : "");
  hydrateLazyThumbnails(paneName);
  if (initialLimit < entries.length) {
    requestAnimationFrame(() =>
      scheduleProgressiveFileRender(paneName, renderToken, entries, renderer, initialLimit, limits.chunk)
    );
  }
  if (paneName === app.activePane) {
    updateSelectionReadout();
  }
}

function renderAll() {
  renderLayoutChrome();
  renderPane("left");
  renderPane("right");
  updateSelectionReadout();
  updateClipboardReadout();
  renderPasteConflictMode();
  renderAutoRefreshToggle();
  renderShowHiddenToggle();
  renderLinkedNavigationToggle();
}

function renderLayoutChrome() {
  const layoutMode = normalizePaneLayout(app.paneLayout);
  const workbench = document.querySelector(".workbench");
  if (workbench) {
    workbench.classList.toggle("layout-vertical", layoutMode === "vertical");
    workbench.classList.toggle("layout-horizontal", layoutMode === "horizontal");
    workbench.classList.toggle("layout-single", layoutMode === "single");
    workbench.classList.toggle("active-left", app.activePane === "left");
    workbench.classList.toggle("active-right", app.activePane === "right");
  }
  document.querySelectorAll("[data-layout-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.layoutMode === layoutMode);
  });
  updateDualPaneActionChrome();
}

function transferDestinationForPane(paneName) {
  const layoutMode = normalizePaneLayout(app.paneLayout);
  if (layoutMode === "horizontal") {
    return paneName === "left"
      ? { direction: "down", label: "bottom pane" }
      : { direction: "up", label: "top pane" };
  }
  if (layoutMode === "vertical") {
    return paneName === "left"
      ? { direction: "right", label: "right pane" }
      : { direction: "left", label: "left pane" };
  }
  return { direction: "hidden", label: "hidden target pane" };
}

function paneSelectionActionDescription(action, count, destination) {
  const itemText = `${count} selected item${count === 1 ? "" : "s"}`;
  if (action === "rename") return `Rename the first of ${itemText}`;
  if (action === "copy-other") return `Copy ${itemText} to the ${destination.label}`;
  if (action === "move-other") return `Move ${itemText} to the ${destination.label}`;
  if (action === "recycle") return `Send ${itemText} to the Windows Recycle Bin`;
  if (action === "bulk-rename") return `Bulk rename ${itemText}`;
  if (action === "label") return `Label ${itemText}`;
  if (action === "trash") return `Move ${itemText} to App Trash`;
  if (action === "delete") return `Permanently delete ${itemText}`;
  return `Run ${action} for ${itemText}`;
}

function paneSelectionActionEmptyDescription(action, destination) {
  if (action === "copy-other") return `Select items to copy to the ${destination.label}`;
  if (action === "move-other") return `Select items to move to the ${destination.label}`;
  if (action === "rename") return "Select an item to rename";
  if (action === "recycle") return "Select items to send to the Windows Recycle Bin";
  if (action === "bulk-rename") return "Select items to bulk rename";
  if (action === "label") return "Select items to label";
  if (action === "trash") return "Select items to move to App Trash";
  if (action === "delete") return "Select items to permanently delete";
  return "Select items first";
}

function updatePaneActionAvailability(paneName) {
  if (!isPaneName(paneName)) return;
  const paneElement = document.querySelector(`.pane[data-pane="${paneName}"]`);
  if (!paneElement) return;
  const count = selectedEntries(paneName).length;
  const destination = transferDestinationForPane(paneName);
  paneElement.classList.toggle("has-selection", count > 0);
  paneElement.querySelectorAll("[data-requires-selection]").forEach((button) => {
    const action = button.dataset.action || "action";
    const description = count
      ? paneSelectionActionDescription(action, count, destination)
      : paneSelectionActionEmptyDescription(action, destination);
    button.disabled = count === 0;
    button.title = description;
    button.setAttribute("aria-label", description);
    button.dataset.selectionCount = String(count);
    if (action === "copy-other" || action === "move-other") {
      button.dataset.transferDirection = destination.direction;
    }
  });
}

function updateDualPaneActionChrome() {
  for (const paneName of ["left", "right"]) {
    const source = paneName === app.activePane;
    const paneElement = document.querySelector(`.pane[data-pane="${paneName}"]`);
    const badge = document.querySelector(`[data-pane-role="${paneName}"]`);
    paneElement?.setAttribute("data-transfer-role", source ? "source" : "target");
    if (badge) {
      badge.textContent = source ? "SOURCE" : "TARGET";
      badge.classList.toggle("source", source);
      badge.classList.toggle("target", !source);
      badge.title = `${paneName === "left" ? "Left" : "Right"} pane is the ${source ? "operation source" : "transfer target"}`;
      badge.setAttribute("aria-label", badge.title);
    }
    updatePaneActionAvailability(paneName);
  }
}

function setPaneLayout(layoutMode, options = {}) {
  const nextLayout = normalizePaneLayout(layoutMode);
  const changed = nextLayout !== app.paneLayout;
  if (nextLayout !== "horizontal") {
    closeCompactBreadcrumbs();
  }
  app.paneLayout = nextLayout;
  renderLayoutChrome();
  if (options.toast !== false) {
    showToast(paneLayoutLabel(nextLayout));
  }
  if (options.save !== false && changed) {
    scheduleStateSave();
  }
}

function shouldBranchLockedNavigation(paneName, targetPath, options = {}) {
  if (options.lockedBranch || options.allowLockedNavigation || !isPaneName(paneName)) {
    return false;
  }
  const tab = tabOf(paneName);
  return Boolean(tab?.locked && tab.path && targetPath && !samePath(tab.path, targetPath));
}

function branchTabFromLocked(sourceTab, targetPath, branchState = {}) {
  const history = Array.isArray(branchState.history)
    ? branchState.history
    : sourceTab.path && !samePath(sourceTab.path, targetPath)
      ? [sourceTab.path]
      : [];
  const future = Array.isArray(branchState.future) ? branchState.future : [];
  return normalizeSavedTab(
    {
      ...sourceTab,
      path: targetPath,
      history,
      future,
      filter: "",
      kindFilter: "all",
      searchMode: false,
      title: "",
      locked: false,
      parent: null
    },
    targetPath
  );
}

async function openLockedNavigationBranch(paneName, targetPath, options = {}, branchState = {}) {
  const pane = panes[paneName];
  const sourceIndex = pane.activeTab;
  const sourceTab = tabOf(paneName);
  const insertIndex = sourceIndex + 1;
  pane.tabs.splice(insertIndex, 0, branchTabFromLocked(sourceTab, targetPath, branchState));
  pane.activeTab = insertIndex;
  app.activePane = paneName;
  try {
    const result = await loadPane(paneName, targetPath, false, {
      ...options,
      lockedBranch: true,
      linkedPreviousPath: branchState.linkedPreviousPath || sourceTab.path
    });
    if (result !== false && !options.silent) {
      showToast("Locked tab opened a new tab");
    }
    return result;
  } catch (error) {
    pane.tabs.splice(insertIndex, 1);
    pane.activeTab = Math.max(0, Math.min(sourceIndex, pane.tabs.length - 1));
    renderPane(paneName);
    throw error;
  }
}

async function loadZipPane(paneName, archivePath, innerPath = "", pushHistory = true, options = {}) {
  const cleanInnerPath = normalizeZipInnerPath(innerPath);
  const tab = tabOf(paneName);
  const previousPath = tab.path;
  const previousSelected = new Set(tab.selected || []);
  const previousFocusedPath = tab.focusedPath;
  const archiveLabel = `${labelForPath(archivePath)}${cleanInnerPath ? `/${cleanInnerPath}` : ""}`;
  const load = beginPaneLoad(paneName, {
    detail: `${paneName === "left" ? "Left" : "Right"} pane loading ZIP ${archiveLabel}`
  });
  const plan = zipListingFetchPlan(archivePath, cleanInnerPath);
  if (!options.silent) {
    setPaneNavigationStatus(paneName, `Loading ${archiveLabel}`);
  }
  if (!options.forceReload) {
    const cached = cachedListing(plan.cacheKey);
    if (cached) {
      const { entries } = applyZipPaneListing(paneName, tab, cached, {
        pushHistory,
        previousPath,
        previousSelected,
        previousFocusedPath,
        options,
        cached: true
      });
      setPaneActivity(paneName, load, "ready", {
        count: entries.length,
        cached: true,
        detail: `${paneName === "left" ? "Left" : "Right"} pane loaded ${entries.length.toLocaleString()} ZIP items from memory cache`
      });
      finishPaneLoad(paneName, load);
      if (!options.silent) {
        setPaneNavigationStatus(
          paneName,
          `${entries.length} ZIP item${entries.length === 1 ? "" : "s"} / cached`
        );
      }
      if (options.save !== false) {
        scheduleStateSave();
      }
      return true;
    }
  } else {
    app.listingCache.delete(plan.cacheKey);
  }

  try {
    const data = await request(`/api/archive/list?${plan.query}`, { signal: load.controller.signal });
    if (!isCurrentPaneLoad(paneName, load)) {
      return false;
    }
    rememberListingCache(plan.cacheKey, data);
    const { entries } = applyZipPaneListing(paneName, tab, data, {
      pushHistory,
      previousPath,
      previousSelected,
      previousFocusedPath,
      options
    });
    setPaneActivity(paneName, load, "ready", {
      count: entries.length,
      wallMs: performance.now() - load.startedAt,
      detail: `${paneName === "left" ? "Left" : "Right"} pane loaded ${entries.length.toLocaleString()} ZIP items in ${compactPaneActivityDuration(
        performance.now() - load.startedAt
      )}`
    });
    if (!options.silent) {
      const truncatedNote = data.truncated
        ? ` / truncated ${data.count || entries.length}/${data.scannedEntries || data.totalEntries || "many"}`
        : "";
      const unsafeNote = data.unsafeEntries ? ` / ${data.unsafeEntries} unsafe skipped` : "";
      setPaneNavigationStatus(
        paneName,
        `${entries.length} ZIP item${entries.length === 1 ? "" : "s"}${truncatedNote}${unsafeNote}${listingTimingText(
          data
        )}`
      );
    }
    if (options.save !== false) {
      scheduleStateSave();
    }
    return true;
  } catch (error) {
    if (isAbortError(error)) {
      return false;
    }
    setPaneActivity(paneName, load, "error", {
      detail: `${paneName === "left" ? "Left" : "Right"} pane could not load ZIP ${archiveLabel}: ${error.message}`
    });
    if (!options.silent) {
      setPaneNavigationStatus(paneName, `Could not open ${archiveLabel}: ${error.message}`);
      showToast(error.message);
    }
    throw error;
  } finally {
    finishPaneLoad(paneName, load);
  }
}

async function loadPane(paneName, targetPath, pushHistory = true, options = {}) {
  const resolvedTargetPath = expandAliasPath(targetPath);
  if (shouldBranchLockedNavigation(paneName, resolvedTargetPath, options)) {
    const sourcePath = tabOf(paneName).path;
    return openLockedNavigationBranch(paneName, resolvedTargetPath, options, {
      history: pushHistory && sourcePath ? [sourcePath] : [],
      linkedPreviousPath: sourcePath
    });
  }
  const zipTarget = parseZipVirtualPath(resolvedTargetPath);
  if (zipTarget) {
    return loadZipPane(paneName, zipTarget.archivePath, zipTarget.innerPath, pushHistory, options);
  }
  const tab = tabOf(paneName);
  const previousPath = tab.path;
  const linkedPreviousPath = options.linkedPreviousPath || previousPath;
  const previousSelected = new Set(tab.selected || []);
  const previousFocusedPath = tab.focusedPath;
  const load = beginPaneLoad(paneName, {
    detail: `${paneName === "left" ? "Left" : "Right"} pane loading ${resolvedTargetPath}`
  });
  const plan = listingFetchPlan(tab, resolvedTargetPath, { includeSignature: false });
  if (!options.silent) {
    setPaneNavigationStatus(paneName, `Loading ${resolvedTargetPath}`);
  }
  if (!options.forceReload) {
    const cached = cachedListing(plan.cacheKey);
    if (cached) {
      const { appliedFormat, selectedTargetPath, entries } = applyPaneListing(paneName, tab, cached, {
        pushHistory,
        previousPath,
        previousSelected,
        previousFocusedPath,
        options,
        cached: true
      });
      setPaneActivity(paneName, load, "ready", {
        count: entries.length,
        wallMs: performance.now() - load.startedAt,
        cached: true,
        detail: `${paneName === "left" ? "Left" : "Right"} pane loaded ${entries.length.toLocaleString()} items from memory cache`
      });
      finishPaneLoad(paneName, load);
      if (!options.silent) {
        const hiddenNote = cached.hiddenFiltered ? ` / ${cached.hiddenFiltered} hidden` : "";
        const targetNote = cached.selectedPath
          ? selectedTargetPath
            ? ` / selected ${labelForPath(selectedTargetPath)}`
            : ` / target hidden`
          : "";
        const redirectNote = cached.redirectedFrom ? ` / redirected from ${labelForPath(cached.redirectedFrom)}` : "";
        const accessNote = cached.accessError ? ` / ${cached.accessError.code || "access denied"}` : "";
        setPaneNavigationStatus(
          paneName,
          `${entries.length} items${hiddenNote}${targetNote}${redirectNote}${accessNote}${appliedFormat ? ` / ${appliedFormat.name}` : ""} / cached`
        );
      }
      if (options.save !== false) {
        scheduleStateSave();
      }
      await maybeFollowLinkedPane(paneName, linkedPreviousPath, cached.path, options);
      return true;
    }
  } else {
    app.listingCache.delete(plan.cacheKey);
    cancelListingPrefetch(plan.cacheKey);
  }
  cancelListingPrefetch(plan.cacheKey);
  let appliedPath = null;
  try {
    const windowQuery = windowedListingQuery(plan.query);
    const data = await request(`/api/list?${windowQuery}`, { signal: load.controller.signal });
    if (!isCurrentPaneLoad(paneName, load)) {
      return false;
    }
    const partial = isWindowedListing(data);
    let finalData = data;
    if (!partial) {
      rememberListingCache(plan.cacheKey, data);
    }
    let { appliedFormat, selectedTargetPath, entries } = applyPaneListing(paneName, tab, data, {
      pushHistory,
      previousPath,
      previousSelected,
      previousFocusedPath,
      options
    });
    if (partial) {
      const returned = Number(data.window?.returned || entries.length);
      const totalKnown = data.window?.totalKnown !== false && Number.isFinite(Number(data.window?.total));
      const total = totalKnown ? Number(data.window.total) : 0;
      setPaneActivity(paneName, load, "hydrating", {
        count: returned,
        total,
        ...(totalKnown ? {} : { text: `${compactPaneActivityCount(returned)}+` }),
        detail: totalKnown
          ? `${paneName === "left" ? "Left" : "Right"} pane showing ${returned.toLocaleString()} of ${total.toLocaleString()} items while the full list loads`
          : `${paneName === "left" ? "Left" : "Right"} pane showing the first ${returned.toLocaleString()} items while the exact total loads`
      });
      if (!options.silent) {
        setPaneNavigationStatus(
          paneName,
          `${listingWindowStatus(data)} / loading full list${listingTimingText(data)}`
        );
      }
      const hydrationQuery = new URLSearchParams(plan.query);
      hydrationQuery.set("format", "compact-v2");
      const fullData = await requestFullListingHydration(plan.cacheKey, hydrationQuery);
      if (!isCurrentPaneLoad(paneName, load)) {
        return false;
      }
      rememberListingCache(plan.cacheKey, fullData);
      finalData = fullData;
      ({ appliedFormat, selectedTargetPath, entries } = applyPaneListing(paneName, tab, fullData, {
        pushHistory: false,
        previousPath: tab.path,
        previousSelected: new Set(tab.selected || []),
        previousFocusedPath: tab.focusedPath,
        options: { ...options, preserveSelection: true }
      }));
      appliedPath = fullData.path;
    } else {
      appliedPath = data.path;
    }
    setPaneActivity(paneName, load, "ready", {
      count: entries.length,
      wallMs: performance.now() - load.startedAt,
      detail: `${paneName === "left" ? "Left" : "Right"} pane loaded ${entries.length.toLocaleString()} items in ${compactPaneActivityDuration(
        performance.now() - load.startedAt
      )}`
    });
    if (!options.silent) {
      const hiddenNote = finalData.hiddenFiltered ? ` / ${finalData.hiddenFiltered} hidden` : "";
      const targetNote = finalData.selectedPath
        ? selectedTargetPath
          ? ` / selected ${labelForPath(selectedTargetPath)}`
          : ` / target hidden`
        : "";
      const redirectNote = finalData.redirectedFrom ? ` / redirected from ${labelForPath(finalData.redirectedFrom)}` : "";
      const accessNote = finalData.accessError ? ` / ${finalData.accessError.code || "access denied"}` : "";
      setPaneNavigationStatus(
        paneName,
        `${entries.length} items${hiddenNote}${targetNote}${redirectNote}${accessNote}${appliedFormat ? ` / ${appliedFormat.name}` : ""}${listingTimingText(finalData)}`
      );
    }
    if (options.save !== false) {
      scheduleStateSave();
    }
  } catch (error) {
    if (isAbortError(error)) {
      return false;
    }
    if (!options.silent) {
      setPaneNavigationStatus(paneName, `Could not open ${resolvedTargetPath}: ${error.message}`);
      showToast(error.message);
    }
    setPaneActivity(paneName, load, "error", {
      detail: `${paneName === "left" ? "Left" : "Right"} pane could not open ${resolvedTargetPath}: ${error.message}`
    });
    throw error;
  } finally {
    finishPaneLoad(paneName, load);
  }
  await maybeFollowLinkedPane(paneName, linkedPreviousPath, appliedPath, options);
  return true;
}

async function refreshPane(paneName, options = {}) {
  await loadPane(paneName, tabOf(paneName).path, false, { ...options, forceReload: options.forceReload !== false });
}

function selectedEntries(paneName) {
  const tab = tabOf(paneName);
  return tab.entries.filter((entry) => tab.selected.has(entry.path));
}

function selectedPaths(paneName) {
  return [...tabOf(paneName).selected];
}

function folderSizeTargetsForPane(paneName = app.activePane) {
  const hasSelection = selectedPaths(paneName).length > 0;
  const source = hasSelection ? selectedEntries(paneName) : visibleEntries(paneName);
  const folders = source.filter((entry) => entry.isDirectory && !entry.unavailable);
  const seen = new Set();
  const paths = [];
  for (const entry of folders) {
    const key = normalizedPathKey(entry.path);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    paths.push(entry.path);
    if (paths.length >= folderSizeScanLimit) {
      break;
    }
  }
  return {
    paths,
    available: folders.length,
    hasSelection,
    capped: folders.length > paths.length
  };
}

function updateEntriesForPaths(paths, update) {
  const wanted = new Set(paths.map(normalizedPathKey));
  const changed = new Set();
  for (const paneName of ["left", "right"]) {
    for (const tab of panes[paneName].tabs) {
      let tabChanged = false;
      for (let index = 0; index < tab.entries.length; index += 1) {
        const entry = tab.entries[index];
        if (wanted.has(normalizedPathKey(entry.path))) {
          const updatedEntry = { ...entry };
          update(updatedEntry);
          tab.entries[index] = updatedEntry;
          tabChanged = true;
        }
      }
      if (tabChanged) {
        invalidateVisibleEntryCache(tab);
        changed.add(paneName);
      }
    }
  }
  return changed;
}

function renderChangedPanes(changedPanes) {
  for (const paneName of changedPanes) {
    renderPane(paneName);
  }
  if (changedPanes.has(app.activePane)) {
    updateSelectionReadout();
    renderInspector();
  }
}

function markFolderSizes(paths, status, errorMessage = "") {
  const changed = updateEntriesForPaths(paths, (entry) => {
    if (!entry.isDirectory) {
      return;
    }
    entry.folderSizeStatus = status;
    entry.folderSizeError = errorMessage;
    if (status === "scanning") {
      entry.folderSizeKnown = false;
    }
  });
  renderChangedPanes(changed);
}

function applyFolderSizeReport(report, requestedPaths) {
  const generatedAt = report.generatedAt || new Date().toISOString();
  const itemsByPath = new Map((report.items || []).map((item) => [normalizedPathKey(item.path), item]));
  const skippedByPath = new Map((report.skipped || []).map((item) => [normalizedPathKey(item.path), item]));
  const changed = updateEntriesForPaths(requestedPaths, (entry) => {
    if (!entry.isDirectory) {
      return;
    }
    const key = normalizedPathKey(entry.path);
    const item = itemsByPath.get(key);
    if (item) {
      entry.size = Number(item.size || 0);
      entry.fileCount = Number(item.fileCount || 0);
      entry.folderCount = Number(item.folderCount || 0);
      entry.scanned = Number(item.scanned || 0);
      entry.folderSizeKnown = true;
      entry.folderSizeStatus = item.truncated || (item.skipped || []).length ? "partial" : "complete";
      entry.folderSizeError = "";
      entry.folderSizeScannedAt = generatedAt;
      entry.folderSizeSkipped = item.skipped || [];
      entry.folderSizeTruncated = item.truncated === true;
      return;
    }
    const skipped = skippedByPath.get(key);
    entry.folderSizeKnown = false;
    entry.folderSizeStatus = "error";
    entry.folderSizeError = skipped?.reason || "Folder size unavailable";
  });
  renderChangedPanes(changed);
}

async function calculateFolderSizes(paneName = app.activePane) {
  const target = folderSizeTargetsForPane(paneName);
  if (!target.paths.length) {
    return showToast(target.hasSelection ? "Selected items do not include folders" : "No folders visible");
  }

  const scope = target.hasSelection ? "selected" : "visible";
  const capped = target.capped ? ` / first ${target.paths.length} of ${target.available}` : "";
  setStatus(`Sizing ${target.paths.length} ${scope} folder(s)${capped}`);
  markFolderSizes(target.paths, "scanning");

  try {
    const report = await request("/api/properties", {
      method: "POST",
      body: JSON.stringify({
        paths: target.paths,
        recursive: true,
        hash: false,
        maxEntries: 50000,
        maxHashBytes: 1
      })
    });
    applyFolderSizeReport(report, target.paths);
    const folders = (report.items || []).filter((item) => item.isDirectory);
    const partial = folders.filter((item) => item.truncated || (item.skipped || []).length).length;
    const failed = (report.skipped || []).length;
    const bytes = folders.reduce((total, item) => total + Number(item.size || 0), 0);
    const status = [
      `Sized ${folders.length} folder(s)`,
      formatSize(bytes),
      partial ? `${partial} partial` : "",
      failed ? `${failed} skipped` : "",
      target.capped ? `first ${target.paths.length} of ${target.available}` : ""
    ]
      .filter(Boolean)
      .join(" / ");
    setStatus(status);
    showToast(status);
  } catch (error) {
    markFolderSizes(target.paths, "error", error.message);
    setStatus("Folder size scan failed");
    showToast(error.message);
  }
}

function sizeAnalysisDefaultPath(paneName = app.activePane) {
  const selected = selectedEntries(paneName).filter((entry) => !entry.unavailable);
  if (selected.length === 1) {
    return selected[0].path;
  }
  return tabOf(paneName).path;
}

function setSizeAnalysisPathToActive() {
  const input = document.getElementById("size-analysis-path");
  if (input) {
    input.value = sizeAnalysisDefaultPath(app.sizeAnalysis.paneName || app.activePane);
  }
}

function updateSizeAnalysisActionState() {
  const scanning = app.sizeAnalysis.loading === true;
  const scan = document.querySelector('[data-size-analysis-action="scan"]');
  const cancel = document.getElementById("size-analysis-cancel");
  const pathInput = document.getElementById("size-analysis-path");
  const maxEntries = document.getElementById("size-analysis-max-entries");
  const followLinks = document.getElementById("size-analysis-follow-links");
  if (scan) {
    scan.disabled = scanning;
    scan.setAttribute("aria-busy", scanning ? "true" : "false");
  }
  if (cancel) {
    cancel.disabled = !scanning;
    cancel.setAttribute("aria-disabled", scanning ? "false" : "true");
  }
  for (const control of [pathInput, maxEntries, followLinks]) {
    if (control) {
      control.disabled = scanning;
    }
  }
}

function cancelSizeAnalysis(message = "Scan canceled") {
  const controller = app.sizeAnalysis.controller;
  const wasLoading = app.sizeAnalysis.loading === true;
  app.sizeAnalysis.requestId = (app.sizeAnalysis.requestId || 0) + 1;
  app.sizeAnalysis.controller = null;
  app.sizeAnalysis.loading = false;
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }
  renderSizeAnalysisDialog(message);
  if (wasLoading) {
    setStatus(message);
  }
}

function sizeAnalysisMetric(label, value, detail = "") {
  const title = [label, value, detail].filter(Boolean).join(" / ");
  return `<div class="size-analysis-metric" title="${escapeHtml(title)}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
    ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
  </div>`;
}

const sizeAnalysisExtensionPalette = {
  ".zip": "#b87913",
  ".7z": "#b87913",
  ".rar": "#b87913",
  ".exe": "#d33f2f",
  ".msi": "#d33f2f",
  ".dll": "#6e7175",
  ".sys": "#6e7175",
  ".mkv": "#8bbf1f",
  ".mp4": "#35a7d6",
  ".mov": "#35a7d6",
  ".avi": "#58b4a2",
  ".mp3": "#8d5bd1",
  ".wav": "#8d5bd1",
  ".flac": "#8d5bd1",
  ".jpg": "#d23f95",
  ".jpeg": "#d23f95",
  ".png": "#2c8ed6",
  ".webp": "#2c8ed6",
  ".gif": "#2c8ed6",
  ".pdf": "#c03a2b",
  ".doc": "#3567b7",
  ".docx": "#3567b7",
  ".xls": "#2c8757",
  ".xlsx": "#2c8757",
  ".ppt": "#c66a2e",
  ".pptx": "#c66a2e",
  ".txt": "#7a8580",
  ".md": "#7a8580",
  ".js": "#d9b31c",
  ".json": "#d9b31c",
  ".css": "#2b7dbd",
  ".html": "#db6b31",
  "(none)": "#5f6d67",
  "(other)": "#3f4443"
};

const sizeAnalysisFallbackPalette = [
  "#08776f",
  "#bf462c",
  "#6957a8",
  "#b87913",
  "#2f8053",
  "#4067a9",
  "#a93577",
  "#5f6d67",
  "#2795a0",
  "#cf7c28"
];

const sizeAnalysisFolderPalette = [
  "#2f9f68",
  "#d14b58",
  "#3a8fca",
  "#9a66c7",
  "#d18b27",
  "#2e9b9a",
  "#788f35",
  "#c45191",
  "#667d94",
  "#df7044"
];

function sizeAnalysisExtensionLabel(extension) {
  const value = String(extension || "").trim().toLowerCase();
  return value || "(none)";
}

function sizeAnalysisExtensionColor(extension) {
  const label = sizeAnalysisExtensionLabel(extension);
  if (sizeAnalysisExtensionPalette[label]) {
    return sizeAnalysisExtensionPalette[label];
  }
  let hash = 0;
  for (const char of label) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return sizeAnalysisFallbackPalette[hash % sizeAnalysisFallbackPalette.length];
}

function sizeAnalysisStablePaletteColor(value, palette = sizeAnalysisFolderPalette) {
  const text = normalizedPathKey(value || "root");
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return palette[hash % palette.length];
}

function sizeAnalysisTreemapValue(item) {
  return app.sizeAnalysis.sizeMode === "allocated" ? sizeAnalysisAllocatedOf(item) : Number(item?.size || 0);
}

function sizeAnalysisTreemapColor(item) {
  if (app.sizeAnalysis.colorMode === "folder") {
    return item?.folderColor || sizeAnalysisStablePaletteColor(item?.parent || item?.path || item?.name);
  }
  return item?.color || sizeAnalysisExtensionColor(item?.extension);
}

function sizeAnalysisPercent(size, totalBytes) {
  const total = Number(totalBytes || 0);
  const value = Number(size || 0);
  return total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
}

function sizeAnalysisPercentText(size, totalBytes) {
  const percent = sizeAnalysisPercent(size, totalBytes);
  return `${percent >= 10 ? percent.toFixed(1) : percent.toFixed(2)}%`;
}

function sizeAnalysisAllocatedOf(item) {
  const allocated = Number(item?.allocated);
  return Number.isFinite(allocated) ? allocated : Number(item?.size || 0);
}

function sizeAnalysisBar(size, totalBytes, color = "#08776f") {
  const percent = sizeAnalysisPercent(size, totalBytes);
  return `<span class="size-analysis-percent-bar" title="${escapeHtml(sizeAnalysisPercentText(size, totalBytes))}">
    <i style="width: ${percent.toFixed(2)}%; background: ${escapeHtml(color)};"></i>
  </span>`;
}

function sizeAnalysisBandSegments(extensions = [], totalBytes = 0, limit = 12) {
  const total = Number(totalBytes || 0);
  const rows = extensions.filter((item) => Number(item.size || 0) > 0).slice(0, limit);
  const visibleBytes = rows.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const otherBytes = Math.max(0, total - visibleBytes);
  const segments = rows.map((item) => ({
    label: sizeAnalysisExtensionLabel(item.extension),
    color: sizeAnalysisExtensionColor(item.extension),
    size: Number(item.size || 0),
    files: Number(item.files || 0)
  }));
  if (otherBytes > 0 && total > 0) {
    segments.push({
      label: "(other)",
      color: sizeAnalysisExtensionColor("(other)"),
      size: otherBytes,
      files: 0
    });
  }
  if (!segments.length && total > 0) {
    segments.push({ label: "files", color: sizeAnalysisExtensionColor("(other)"), size: total, files: 0 });
  }
  return segments
    .map((segment) => {
      const percent = sizeAnalysisPercent(segment.size, total);
      const width = percent > 0 ? Math.max(0.45, percent) : 0;
      return `<i class="size-analysis-band-segment" style="width: ${width.toFixed(3)}%; background: ${escapeHtml(
        segment.color
      )};" title="${escapeHtml(
        `${segment.label} / ${formatSize(segment.size)} / ${sizeAnalysisPercentText(segment.size, total)}`
      )}"></i>`;
    })
    .join("");
}

function sizeAnalysisIdleStrip() {
  return `<div class="size-analysis-scan-line">
    <strong>Ready to scan</strong>
    <span>Folder totals, extension chart, top files, and file map</span>
  </div>
  <div class="size-analysis-progress-track" aria-hidden="true"><i style="width: 0%;"></i></div>`;
}

function sizeAnalysisLoadingStrip(message = "Scanning...") {
  return `<div class="size-analysis-scan-line">
    <strong>${escapeHtml(message)}</strong>
    <span>Walking the tree with capped entries and yielding between batches</span>
  </div>
  <div class="size-analysis-progress-track is-loading" aria-hidden="true"><i></i></div>`;
}

function sizeAnalysisSpaceText(space, totalBytes) {
  if (!space?.available) {
    return `${formatSize(totalBytes)} selected`;
  }
  return `${formatSize(space.usedBytes)} used / ${formatSize(space.freeBytes)} free / ${formatSize(space.totalBytes)} total`;
}

function sizeAnalysisScanStrip(report) {
  const totalBytes = Number(report?.summary?.bytes || 0);
  const elapsed = Math.round(Number(report?.summary?.elapsedMs || 0));
  const scanned = Number(report?.scanned || 0);
  const skipped = Number(report?.summary?.skipped || 0);
  const cap = report?.cache?.hit
    ? "Warm cache"
    : report?.truncated
      ? `Capped at ${Number(report.maxEntries || 0).toLocaleString()} entries`
      : "Scan complete";
  const cacheText = report?.cache?.hit
    ? `saved ${Math.max(0, Math.round(Number(report.cache.originalElapsedMs || 0) - elapsed)).toLocaleString()}ms`
    : "";
  const space = report?.space || null;
  const root = space?.root || report?.path || "";
  const share = space?.available && Number(space.totalBytes || 0) > 0 ? `${sizeAnalysisPercentText(totalBytes, space.totalBytes)} of volume` : "";
  return `<div class="size-analysis-scan-line">
    <strong>${escapeHtml(cap)}</strong>
    <span>${escapeHtml(
      [
        scanned === 1 ? "1 entry" : `${scanned.toLocaleString()} entries`,
        skipped ? `${skipped.toLocaleString()} skipped` : "no skipped items",
        `${elapsed}ms`,
        cacheText
      ]
        .filter(Boolean)
        .join(" / ")
    )}</span>
    <span title="${escapeHtml(root)}">${escapeHtml([sizeAnalysisSpaceText(space, totalBytes), share].filter(Boolean).join(" / "))}</span>
  </div>
  <div class="size-analysis-progress-track" aria-label="Size by extension">
    ${sizeAnalysisBandSegments(report?.extensions || [], totalBytes)}
  </div>`;
}

function sizeAnalysisVisibleTreeRows(tree, limit = 40) {
  const rows = [];
  const visit = (node, parentSize = 0, parentPath = "", parentAllocated = 0) => {
    if (!node || rows.length >= limit) {
      return;
    }
    rows.push({
      name: node.name,
      path: node.path,
      parent: parentPath,
      parentSize: Number(parentSize || node.size || 0),
      size: Number(node.size || 0),
      allocated: sizeAnalysisAllocatedOf(node),
      parentAllocated: Number(parentAllocated || sizeAnalysisAllocatedOf(node)),
      files: Number(node.files || 0),
      folders: Number(node.folders || 0),
      modified: node.modified,
      depth: Number(node.depth || 0)
    });
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      if (rows.length >= limit) {
        break;
      }
      visit(child, Number(node.size || 0), node.path || parentPath, sizeAnalysisAllocatedOf(node));
    }
  };
  visit(tree);
  return rows;
}

function sizeAnalysisOpenAttrs(item, options = {}) {
  if (!options.openPath || !item?.path) {
    return "";
  }
  const attrs = [`data-size-analysis-open="${escapeHtml(item.path)}"`];
  if (options.selectPath && item.parent) {
    attrs.push(`data-size-analysis-parent="${escapeHtml(item.parent)}"`);
    attrs.push(`data-size-analysis-select="${escapeHtml(item.path)}"`);
  }
  return attrs.join(" ");
}

function sizeAnalysisFolderRow(item, totalBytes) {
  const parentBytes = Number(item.parentSize || 0) || totalBytes;
  const items = Number(item.files || 0) + Number(item.folders || 0);
  const percent = sizeAnalysisPercentText(item.size, parentBytes);
  const depth = Math.max(0, Math.min(8, Number(item.depth || 0)));
  return `<button type="button" class="size-analysis-row size-analysis-folder-row" ${sizeAnalysisOpenAttrs(
    item,
    { openPath: true }
  )} title="${escapeHtml(item.path || item.name)}">
    <span class="size-analysis-name-cell size-analysis-tree-name" style="--size-tree-depth: ${depth};">
      <strong>${escapeHtml(item.name || "(folder)")}</strong>
      <small>${escapeHtml(item.parent || item.path || "")}</small>
    </span>
    <span class="size-analysis-parent-cell">${sizeAnalysisBar(item.size, parentBytes)}<b>${escapeHtml(percent)}</b></span>
    <span class="size-analysis-size-cell">${escapeHtml(formatSize(item.size))}</span>
    <span class="size-analysis-size-cell">${escapeHtml(formatSize(sizeAnalysisAllocatedOf(item)))}</span>
    <span>${items.toLocaleString()}</span>
    <span>${Number(item.files || 0).toLocaleString()}</span>
    <span>${Number(item.folders || 0).toLocaleString()}</span>
    <span>${escapeHtml(formatDate(item.modified))}</span>
  </button>`;
}

function sizeAnalysisFileRow(item, totalBytes) {
  const extension = sizeAnalysisExtensionLabel(item.extension);
  const color = sizeAnalysisExtensionColor(extension);
  return `<button type="button" class="size-analysis-row size-analysis-file-row" ${sizeAnalysisOpenAttrs(item, {
    openPath: true,
    selectPath: true
  })} title="${escapeHtml(item.path || item.name)}">
    <span class="size-analysis-name-cell">
      <strong>${escapeHtml(item.name || "(file)")}</strong>
      <small>${escapeHtml(item.parent || "")}</small>
    </span>
    <span class="size-analysis-type-cell"><i style="background: ${escapeHtml(color)};"></i>${escapeHtml(
      item.kind || extension
    )}</span>
    <span class="size-analysis-size-cell">${escapeHtml(formatSize(item.size))}</span>
    <span class="size-analysis-size-cell">${escapeHtml(formatSize(sizeAnalysisAllocatedOf(item)))}</span>
    <span>${escapeHtml(sizeAnalysisPercentText(item.size, totalBytes))}</span>
    <span>${escapeHtml(formatDate(item.modified))}</span>
  </button>`;
}

function sizeAnalysisExtensionRow(item, totalBytes) {
  const extension = sizeAnalysisExtensionLabel(item.extension);
  const color = sizeAnalysisExtensionColor(extension);
  return `<div class="size-analysis-row size-analysis-extension-row" title="${escapeHtml(
    `${extension} / ${item.kind || ""} / ${item.category || "Other"}`
  )}">
    <span class="size-analysis-type-cell"><i style="background: ${escapeHtml(color)};"></i><strong>${escapeHtml(
      extension
    )}</strong></span>
    <span class="size-analysis-kind-cell">${escapeHtml(item.kind || item.category || "File")}</span>
    <span class="size-analysis-parent-cell">${sizeAnalysisBar(item.size, totalBytes, color)}<b>${escapeHtml(
      sizeAnalysisPercentText(item.size, totalBytes)
    )}</b></span>
    <span class="size-analysis-size-cell">${escapeHtml(formatSize(item.size))}</span>
    <span class="size-analysis-size-cell">${escapeHtml(formatSize(sizeAnalysisAllocatedOf(item)))}</span>
    <span>${Number(item.files || 0).toLocaleString()}</span>
  </div>`;
}

function sizeAnalysisMapLegendItems(report = app.sizeAnalysis.report) {
  if (!report) return [];
  if (app.sizeAnalysis.colorMode === "folder") {
    const root = report.tree;
    const branches = (Array.isArray(root?.children) && root.children.length ? root.children : root ? [root] : []).slice(0, 10);
    return branches.map((item) => ({
      label: item.name || "Root",
      color: sizeAnalysisStablePaletteColor(item.path || item.name),
      value: sizeAnalysisTreemapValue(item)
    }));
  }
  return (report.extensions || []).slice(0, 10).map((item) => ({
    label: sizeAnalysisExtensionLabel(item.extension),
    color: sizeAnalysisExtensionColor(item.extension),
    value: app.sizeAnalysis.sizeMode === "allocated" ? sizeAnalysisAllocatedOf(item) : Number(item.size || 0)
  }));
}

function renderSizeAnalysisViewState() {
  const viewMode = app.sizeAnalysis.viewMode === "map" ? "map" : "overview";
  const sizeMode = app.sizeAnalysis.sizeMode === "allocated" ? "allocated" : "logical";
  const colorMode = app.sizeAnalysis.colorMode === "folder" ? "folder" : "type";
  app.sizeAnalysis.viewMode = viewMode;
  app.sizeAnalysis.sizeMode = sizeMode;
  app.sizeAnalysis.colorMode = colorMode;
  const dialog = document.getElementById("size-analysis-dialog");
  const panel = dialog?.querySelector(".size-analysis-panel");
  dialog?.classList.toggle("map-view", viewMode === "map");
  panel?.classList.toggle("map-view", viewMode === "map");
  document.querySelectorAll("[data-size-analysis-view]").forEach((button) => {
    const active = button.dataset.sizeAnalysisView === viewMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
  });
  const sizeSelect = document.getElementById("size-analysis-size-by");
  const colorSelect = document.getElementById("size-analysis-color-by");
  if (sizeSelect) sizeSelect.value = sizeMode;
  if (colorSelect) colorSelect.value = colorMode;
  const legend = document.getElementById("size-analysis-map-legend");
  if (legend) {
    const items = sizeAnalysisMapLegendItems();
    legend.innerHTML = items.length
      ? items
          .map(
            (item) => `<span title="${escapeHtml(`${item.label} / ${formatSize(item.value)}`)}"><i style="background:${escapeHtml(
              item.color
            )}"></i>${escapeHtml(item.label)}</span>`
          )
          .join("")
      : '<span class="size-analysis-map-legend-empty">Scan to build legend</span>';
  }
}

function queueSizeAnalysisTreemapDraw() {
  requestAnimationFrame(() => requestAnimationFrame(() => drawSizeTreemap(app.sizeAnalysis.report)));
}

function setSizeAnalysisViewMode(mode) {
  app.sizeAnalysis.viewMode = mode === "map" ? "map" : "overview";
  renderSizeAnalysisViewState();
  queueSizeAnalysisTreemapDraw();
  setStatus(app.sizeAnalysis.viewMode === "map" ? "Disk Map workspace" : "Analyzer overview");
}

function setSizeAnalysisMapEncoding({ sizeMode = app.sizeAnalysis.sizeMode, colorMode = app.sizeAnalysis.colorMode } = {}) {
  app.sizeAnalysis.sizeMode = sizeMode === "allocated" ? "allocated" : "logical";
  app.sizeAnalysis.colorMode = colorMode === "folder" ? "folder" : "type";
  app.sizeAnalysis.treemapHover = null;
  app.sizeAnalysis.treemapSelection = null;
  renderSizeAnalysisViewState();
  setSizeAnalysisMapDetail(null);
  queueSizeAnalysisTreemapDraw();
  setStatus(
    `Disk Map sized by ${app.sizeAnalysis.sizeMode === "allocated" ? "allocated" : "logical"} bytes and colored by ${
      app.sizeAnalysis.colorMode === "folder" ? "top folder" : "file type"
    }`
  );
}

function sizeAnalysisReportDataMatches(left, right) {
  return Boolean(
    left &&
      right &&
      left.generatedAt &&
      left.generatedAt === right.generatedAt &&
      samePath(left.path, right.path) &&
      Number(left.scanned || 0) === Number(right.scanned || 0) &&
      Number(left.summary?.bytes || 0) === Number(right.summary?.bytes || 0)
  );
}

function renderSizeAnalysisSummary(report, message = "") {
  const summary = document.getElementById("size-analysis-summary");
  const scanStrip = document.getElementById("size-analysis-scan-strip");
  if (!summary || !report) return;
  const totalBytes = Number(report.summary?.bytes || 0);
  const truncated = report.truncated ? " / capped" : "";
  summary.textContent =
    message || `${formatSize(totalBytes)} / ${itemWord(Number(report.summary?.files || 0), "file")}${truncated}`;
  if (scanStrip) scanStrip.innerHTML = sizeAnalysisScanStrip(report);
}

function renderSizeAnalysisDialog(message = "") {
  const report = app.sizeAnalysis.report;
  const summary = document.getElementById("size-analysis-summary");
  const metrics = document.getElementById("size-analysis-metrics");
  const scanStrip = document.getElementById("size-analysis-scan-strip");
  const folders = document.getElementById("size-analysis-folders");
  const files = document.getElementById("size-analysis-files");
  const extensions = document.getElementById("size-analysis-extensions");
  const folderCount = document.getElementById("size-analysis-folder-count");
  const fileCount = document.getElementById("size-analysis-file-count");
  const extensionCount = document.getElementById("size-analysis-extension-count");
  const mapCount = document.getElementById("size-analysis-map-count");
  if (!summary || !metrics || !folders || !files || !extensions) {
    return;
  }
  updateSizeAnalysisActionState();
  renderSizeAnalysisViewState();
  if (app.sizeAnalysis.loading) {
    const requestedPath = document.getElementById("size-analysis-path")?.value || "";
    if (report && samePath(report.path, requestedPath)) {
      summary.textContent = message || "Refreshing...";
      if (scanStrip) scanStrip.innerHTML = sizeAnalysisLoadingStrip(message || "Refreshing...");
      return;
    }
    summary.textContent = message || "Scanning...";
    if (scanStrip) scanStrip.innerHTML = sizeAnalysisLoadingStrip(message || "Scanning...");
    metrics.innerHTML = `<div class="empty-state">Scanning disk usage</div>`;
    folders.innerHTML = `<div class="empty-state">Folders will appear after scan</div>`;
    files.innerHTML = `<div class="empty-state">Files will appear after scan</div>`;
    extensions.innerHTML = `<div class="empty-state">Extensions will appear after scan</div>`;
    app.sizeAnalysis.treemapRects = [];
    app.sizeAnalysis.treemapHover = null;
    app.sizeAnalysis.treemapSelection = null;
    app.sizeAnalysis.treemapFocusPath = "";
    setSizeAnalysisMapDetail(null, "Scanning file map...");
    renderSizeAnalysisMapNavigation(null);
    if (mapCount) mapCount.textContent = "0";
    drawSizeTreemap(null);
    return;
  }
  if (!report) {
    summary.textContent = message || "Ready";
    if (scanStrip) scanStrip.innerHTML = sizeAnalysisIdleStrip();
    metrics.innerHTML = `<div class="empty-state">Scan a folder or file to see disk usage</div>`;
    folders.innerHTML = `<div class="empty-state">No folder scan yet</div>`;
    files.innerHTML = `<div class="empty-state">No file scan yet</div>`;
    extensions.innerHTML = `<div class="empty-state">No extension scan yet</div>`;
    if (folderCount) folderCount.textContent = "0";
    if (fileCount) fileCount.textContent = "0";
    if (extensionCount) extensionCount.textContent = "0";
    app.sizeAnalysis.treemapRects = [];
    app.sizeAnalysis.treemapHover = null;
    app.sizeAnalysis.treemapSelection = null;
    app.sizeAnalysis.treemapFocusPath = "";
    setSizeAnalysisMapDetail(null, "Scan to map files");
    renderSizeAnalysisMapNavigation(null);
    if (mapCount) mapCount.textContent = "0";
    drawSizeTreemap(null);
    return;
  }
  const totalBytes = Number(report.summary?.bytes || 0);
  const allocatedBytes = Number(report.summary?.allocated || totalBytes);
  const skipped = Number(report.summary?.skipped || 0);
  const allocationLabel = report.allocationAccuracy === "exact"
    ? `Exact via ${report.allocatedSource || "filesystem"}${report.clusterSize ? ` / ${formatSize(report.clusterSize)} clusters` : ""}`
    : `Estimated${report.clusterSize ? ` / ${formatSize(report.clusterSize)} clusters` : ""}`;
  renderSizeAnalysisSummary(report, message);
  const metricCards = [
    sizeAnalysisMetric("Total", formatSize(totalBytes), report.path),
    sizeAnalysisMetric(
      "Allocated",
      formatSize(allocatedBytes),
      report.space?.available
        ? `${sizeAnalysisPercentText(allocatedBytes, report.space.totalBytes)} of volume / ${allocationLabel}`
        : allocationLabel
    ),
    sizeAnalysisMetric("Files", Number(report.summary?.files || 0).toLocaleString(), `${Number(report.scanned || 0).toLocaleString()} scanned`),
    sizeAnalysisMetric("Folders", Number(report.summary?.folders || 0).toLocaleString(), report.truncated ? "truncated" : "complete"),
    sizeAnalysisMetric(
      "Types",
      Number(report.summary?.extensions || 0).toLocaleString(),
      `${Number(report.summary?.categories || 0).toLocaleString()} categories${skipped ? ` / ${skipped} skipped` : ""}`
    )
  ];
  if (report.space?.available) {
    metricCards.push(
      sizeAnalysisMetric(
        "Drive Free",
        formatSize(report.space.freeBytes),
        `${Math.round(Number(report.space.freePercent || 0))}% free on ${report.space.root || "volume"}`
      )
    );
  }
  metrics.innerHTML = metricCards.join("");
  const folderRows = sizeAnalysisVisibleTreeRows(report.tree, 32);
  const topFiles = report.topFiles || [];
  const topExtensions = report.extensions || [];
  if (folderCount) {
    const totalFolders = Number(report.summary?.folders || 0) + 1;
    folderCount.textContent = `${Math.min(folderRows.length, 9).toLocaleString()} / ${totalFolders.toLocaleString()}`;
  }
  if (fileCount) fileCount.textContent = topFiles.length.toLocaleString();
  if (extensionCount) extensionCount.textContent = topExtensions.length.toLocaleString();
  if (mapCount) mapCount.textContent = `${Math.min(topFiles.length, 900).toLocaleString()} mapped`;
  renderSizeAnalysisMapNavigation(report);
  setSizeAnalysisMapDetail(app.sizeAnalysis.treemapHover || app.sizeAnalysis.treemapSelection);
  folders.innerHTML = folderRows.length
    ? folderRows.slice(0, 9).map((item) => sizeAnalysisFolderRow(item, totalBytes)).join("")
    : `<div class="empty-state">No folders</div>`;
  files.innerHTML = topFiles.length
    ? topFiles.slice(0, 11).map((item) => sizeAnalysisFileRow(item, totalBytes)).join("")
    : `<div class="empty-state">No files</div>`;
  extensions.innerHTML = topExtensions.length
    ? topExtensions.slice(0, 9).map((item) => sizeAnalysisExtensionRow(item, totalBytes)).join("")
    : `<div class="empty-state">No extensions</div>`;
  requestAnimationFrame(() => drawSizeTreemap(report));
}

function openSizeAnalysisDialog(paneName = app.activePane, viewMode = app.sizeAnalysis.viewMode) {
  app.sizeAnalysis.paneName = paneName;
  app.sizeAnalysis.viewMode = viewMode === "map" ? "map" : "overview";
  const defaultPath = sizeAnalysisDefaultPath(paneName);
  if (app.sizeAnalysis.report?.path && !samePath(app.sizeAnalysis.report.path, defaultPath)) {
    app.sizeAnalysis.report = null;
    app.sizeAnalysis.treemapRects = [];
    app.sizeAnalysis.treemapHover = null;
    app.sizeAnalysis.treemapSelection = null;
    app.sizeAnalysis.treemapFocusPath = "";
  }
  const input = document.getElementById("size-analysis-path");
  if (input) {
    input.value = defaultPath;
  }
  renderSizeAnalysisDialog();
  document.getElementById("size-analysis-dialog").showModal();
}

async function runSizeAnalysis() {
  if (app.sizeAnalysis.loading) {
    cancelSizeAnalysis("Restarting scan");
  }
  const requestId = (app.sizeAnalysis.requestId || 0) + 1;
  const controller = new AbortController();
  app.sizeAnalysis.requestId = requestId;
  app.sizeAnalysis.controller = controller;
  app.sizeAnalysis.loading = true;
  renderSizeAnalysisDialog("Scanning...");
  const body = {
    path: document.getElementById("size-analysis-path")?.value || sizeAnalysisDefaultPath(app.sizeAnalysis.paneName),
    maxEntries: Number(document.getElementById("size-analysis-max-entries")?.value || 100000),
    followLinks: document.getElementById("size-analysis-follow-links")?.checked === true
  };
  setStatus(`Analyzing ${body.path}`);
  try {
    const report = await request("/api/size-analysis", {
      method: "POST",
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (app.sizeAnalysis.requestId !== requestId) {
      return;
    }
    const previousReport = app.sizeAnalysis.report;
    const unchangedWarmReport = report.cache?.hit === true && sizeAnalysisReportDataMatches(previousReport, report);
    app.sizeAnalysis.report = report;
    app.sizeAnalysis.controller = null;
    app.sizeAnalysis.loading = false;
    document.getElementById("size-analysis-path").value = report.path || body.path;
    if (unchangedWarmReport) {
      updateSizeAnalysisActionState();
      renderSizeAnalysisSummary(report);
    } else {
      app.sizeAnalysis.treemapHover = null;
      app.sizeAnalysis.treemapSelection = null;
      app.sizeAnalysis.treemapFocusPath = "";
      renderSizeAnalysisDialog();
    }
    setStatus(`Analyzed ${formatSize(report.summary?.bytes || 0)} in ${Math.round(Number(report.summary?.elapsedMs || 0))}ms`);
  } catch (error) {
    if (app.sizeAnalysis.requestId !== requestId) {
      return;
    }
    app.sizeAnalysis.controller = null;
    app.sizeAnalysis.loading = false;
    if (isAbortError(error)) {
      renderSizeAnalysisDialog("Scan canceled");
      setStatus("Size analysis canceled");
      return;
    }
    renderSizeAnalysisDialog(error.message);
    setStatus("Size analysis failed");
    showToast(error.message);
  }
}

function sizeAnalysisTreemapItems(report) {
  return (report?.topFiles || [])
    .filter((item) => sizeAnalysisTreemapValue(item) > 0)
    .slice(0, 900)
    .map((item) => ({
      ...item,
      extension: sizeAnalysisExtensionLabel(item.extension),
      allocated: sizeAnalysisAllocatedOf(item),
      color: sizeAnalysisExtensionColor(item.extension)
    }))
    .sort((left, right) => sizeAnalysisTreemapValue(right) - sizeAnalysisTreemapValue(left));
}

function sizeAnalysisPathContains(folderPath, itemPath) {
  const folder = normalizedPathKey(folderPath);
  const item = normalizedPathKey(itemPath);
  if (!folder || !item) {
    return false;
  }
  return item === folder || item.startsWith(`${folder}\\`) || item.startsWith(`${folder}/`);
}

function sizeAnalysisTreemapHierarchy(report) {
  const sourceRoot = report?.tree;
  if (!sourceRoot || sizeAnalysisTreemapValue(sourceRoot) <= 0) {
    return null;
  }
  const folderNodes = [];
  const cloneFolder = (source, parent = null) => {
    const node = {
      name: source.name || source.path || "Folder",
      path: source.path || "",
      parent: parent?.path || parentPathOf(source.path || ""),
      extension: "",
      kind: "Folder",
      size: Number(source.size || 0),
      allocated: sizeAnalysisAllocatedOf(source),
      mapSize: sizeAnalysisTreemapValue(source),
      modified: source.modified,
      treemapGroup: true,
      virtualRemainder: false,
      folderChildren: [],
      fileChildren: [],
      children: []
    };
    folderNodes.push(node);
    node.folderChildren = (Array.isArray(source.children) ? source.children : [])
      .filter((child) => sizeAnalysisTreemapValue(child) > 0)
      .map((child) => cloneFolder(child, node));
    return node;
  };
  const root = cloneFolder(sourceRoot);
  for (const file of sizeAnalysisTreemapItems(report)) {
    const fileParent = file.parent || parentPathOf(file.path || "");
    let owner = root;
    for (const folder of folderNodes) {
      if (
        sizeAnalysisPathContains(folder.path, fileParent) &&
        normalizedPathKey(folder.path).length > normalizedPathKey(owner.path).length
      ) {
        owner = folder;
      }
    }
    file.mapSize = sizeAnalysisTreemapValue(file);
    owner.fileChildren.push(file);
  }
  const colorFolderBranches = (folder, branchColor = "", rootFolder = false) => {
    folder.folderColor = branchColor || sizeAnalysisStablePaletteColor(folder.path || folder.name);
    folder.fileChildren.forEach((file) => {
      file.folderColor = folder.folderColor;
    });
    folder.folderChildren.forEach((child) => {
      colorFolderBranches(child, rootFolder ? sizeAnalysisStablePaletteColor(child.path || child.name) : folder.folderColor, false);
    });
  };
  colorFolderBranches(root, sizeAnalysisStablePaletteColor(root.path || root.name), true);
  const finishFolder = (folder) => {
    folder.folderChildren.forEach(finishFolder);
    const represented = [...folder.folderChildren, ...folder.fileChildren];
    const logicalRemainder = Math.max(
      0,
      Number(folder.size || 0) - represented.reduce((sum, child) => sum + Number(child.size || 0), 0)
    );
    const allocatedRemainder = Math.max(
      0,
      sizeAnalysisAllocatedOf(folder) - represented.reduce((sum, child) => sum + sizeAnalysisAllocatedOf(child), 0)
    );
    const mapRemainder = Math.max(
      0,
      Number(folder.mapSize || 0) - represented.reduce((sum, child) => sum + Number(child.mapSize ?? sizeAnalysisTreemapValue(child)), 0)
    );
    folder.children = represented;
    if (mapRemainder > 0) {
      folder.children.push({
        name: "Other files",
        path: folder.path,
        parent: folder.path,
        extension: "(other)",
        kind: "Remainder",
        size: logicalRemainder,
        allocated: allocatedRemainder,
        mapSize: mapRemainder,
        modified: null,
        color: sizeAnalysisExtensionColor("(other)"),
        folderColor: folder.folderColor,
        virtualRemainder: true,
        treemapGroup: false
      });
    }
    folder.children.sort(
      (left, right) => Number(right.mapSize ?? sizeAnalysisTreemapValue(right)) - Number(left.mapSize ?? sizeAnalysisTreemapValue(left))
    );
    delete folder.folderChildren;
    delete folder.fileChildren;
  };
  finishFolder(root);
  return root;
}

function sizeAnalysisTreemapFindNode(root, itemPath) {
  const target = normalizedPathKey(itemPath);
  if (!root || !target) {
    return root || null;
  }
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (normalizedPathKey(node?.path) === target) {
      return node;
    }
    const children = Array.isArray(node?.children) ? node.children : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      if (children[index]?.treemapGroup) {
        pending.push(children[index]);
      }
    }
  }
  return null;
}

function sizeAnalysisTreemapAncestry(root, itemPath) {
  const target = normalizedPathKey(itemPath || root?.path);
  if (!root || !target) {
    return root ? [root] : [];
  }
  const visit = (node, trail) => {
    const nextTrail = [...trail, node];
    if (normalizedPathKey(node?.path) === target) {
      return nextTrail;
    }
    for (const child of Array.isArray(node?.children) ? node.children : []) {
      if (!child?.treemapGroup) continue;
      const result = visit(child, nextTrail);
      if (result) return result;
    }
    return null;
  };
  return visit(root, []) || [root];
}

function sizeAnalysisTreemapFocusNode(hierarchy) {
  if (!hierarchy) {
    return null;
  }
  const requested = app.sizeAnalysis.treemapFocusPath;
  const focused = requested ? sizeAnalysisTreemapFindNode(hierarchy, requested) : hierarchy;
  if (!focused?.treemapGroup) {
    app.sizeAnalysis.treemapFocusPath = "";
    return hierarchy;
  }
  if (normalizedPathKey(focused.path) === normalizedPathKey(hierarchy.path)) {
    app.sizeAnalysis.treemapFocusPath = "";
  }
  return focused;
}

function renderSizeAnalysisMapNavigation(report = app.sizeAnalysis.report, hierarchy = null) {
  const breadcrumbs = document.getElementById("size-analysis-map-breadcrumbs");
  const rootButton = document.querySelector('[data-size-analysis-map-action="root"]');
  const upButton = document.querySelector('[data-size-analysis-map-action="up"]');
  const focusButton = document.querySelector('[data-size-analysis-map-action="focus"]');
  const openButton = document.querySelector('[data-size-analysis-map-action="open"]');
  const tree = hierarchy || sizeAnalysisTreemapHierarchy(report);
  const focused = sizeAnalysisTreemapFocusNode(tree);
  const selection = app.sizeAnalysis.treemapSelection;
  const atRoot = !tree || !focused || normalizedPathKey(focused.path) === normalizedPathKey(tree.path);
  if (rootButton) rootButton.disabled = atRoot;
  if (upButton) upButton.disabled = atRoot;
  if (focusButton) focusButton.disabled = !selection?.treemapGroup;
  if (openButton) openButton.disabled = !selection || selection.virtualRemainder || !selection.path;
  if (!breadcrumbs) {
    return;
  }
  if (!tree || !focused) {
    breadcrumbs.innerHTML = '<span class="size-analysis-map-empty-path">No map focus</span>';
    return;
  }
  const ancestry = sizeAnalysisTreemapAncestry(tree, focused.path);
  breadcrumbs.innerHTML = ancestry
    .map((node, index) => {
      const isCurrent = index === ancestry.length - 1;
      const focusPath = index === 0 ? "" : node.path || "";
      const separator = index ? '<span class="size-analysis-map-separator" aria-hidden="true">&gt;</span>' : "";
      return `${separator}<button type="button" data-size-analysis-map-focus="${escapeHtml(focusPath)}" title="${escapeHtml(
        node.path || node.name || "Scan root"
      )}"${isCurrent ? ' aria-current="location"' : ""}>${escapeHtml(node.name || "Root")}</button>`;
    })
    .join("");
}

function focusSizeAnalysisTreemap(itemPath = "") {
  const hierarchy = sizeAnalysisTreemapHierarchy(app.sizeAnalysis.report);
  if (!hierarchy) {
    return;
  }
  const node = itemPath ? sizeAnalysisTreemapFindNode(hierarchy, itemPath) : hierarchy;
  if (!node?.treemapGroup) {
    showToast("Choose a folder group to focus");
    return;
  }
  app.sizeAnalysis.treemapFocusPath = normalizedPathKey(node.path) === normalizedPathKey(hierarchy.path) ? "" : node.path || "";
  app.sizeAnalysis.treemapHover = null;
  app.sizeAnalysis.treemapSelection = null;
  setSizeAnalysisMapDetail(null, `Focused on ${node.name || "scan root"}`);
  renderSizeAnalysisMapNavigation(app.sizeAnalysis.report, hierarchy);
  drawSizeTreemap(app.sizeAnalysis.report);
  setStatus(`Disk map focused on ${node.name || node.path}`);
}

function focusSizeAnalysisTreemapParent() {
  const hierarchy = sizeAnalysisTreemapHierarchy(app.sizeAnalysis.report);
  const focused = sizeAnalysisTreemapFocusNode(hierarchy);
  if (!hierarchy || !focused) {
    return;
  }
  const ancestry = sizeAnalysisTreemapAncestry(hierarchy, focused.path);
  const parent = ancestry.length > 1 ? ancestry[ancestry.length - 2] : hierarchy;
  focusSizeAnalysisTreemap(parent === hierarchy ? "" : parent.path);
}

function sizeAnalysisTreemapKey(item) {
  return [item?.path || "", item?.name || "", item?.extension || "", Number(item?.size || 0)].join("\u0000");
}

function sizeAnalysisTreemapLabel(item, report = app.sizeAnalysis.report) {
  if (!item) {
    return "";
  }
  const totalBytes =
    app.sizeAnalysis.sizeMode === "allocated"
      ? Number(report?.summary?.allocated || report?.summary?.bytes || 0)
      : Number(report?.summary?.bytes || 0);
  const measuredBytes = Number(item.mapSize ?? sizeAnalysisTreemapValue(item));
  return [
    item.name || "(file)",
    item.kind || sizeAnalysisExtensionLabel(item.extension),
    formatSize(item.size),
    `${formatSize(sizeAnalysisAllocatedOf(item))} allocated`,
    `${sizeAnalysisPercentText(measuredBytes, totalBytes)} of ${app.sizeAnalysis.sizeMode}`
  ]
    .filter(Boolean)
    .join(" / ");
}

function setSizeAnalysisMapDetail(item = null, fallback = "") {
  const detail = document.getElementById("size-analysis-map-detail");
  if (!detail) {
    return;
  }
  const visibleItem = item || app.sizeAnalysis.treemapSelection;
  detail.textContent = visibleItem
    ? sizeAnalysisTreemapLabel(visibleItem)
    : fallback || (app.sizeAnalysis.report ? "Hover or click a file block" : "Scan to map files");
}

function sizeAnalysisTreemapWorstAspect(row, side) {
  if (!row.length || side <= 0) {
    return Infinity;
  }
  const areas = row.map((entry) => Number(entry.area || 0)).filter((area) => area > 0);
  if (!areas.length) {
    return Infinity;
  }
  const sum = areas.reduce((total, area) => total + area, 0);
  const min = Math.min(...areas);
  const max = Math.max(...areas);
  if (sum <= 0 || min <= 0) {
    return Infinity;
  }
  const sideSquared = side * side;
  return Math.max((sideSquared * max) / (sum * sum), (sum * sum) / (sideSquared * min));
}

function pushSizeAnalysisTreemapRow(row, rect, rects, depth) {
  const area = row.reduce((total, entry) => total + Number(entry.area || 0), 0);
  if (!row.length || area <= 0 || rect.w <= 0 || rect.h <= 0) {
    return rect;
  }
  if (rect.w >= rect.h) {
    const rowWidth = Math.max(0, Math.min(rect.w, area / Math.max(1, rect.h)));
    let y = rect.y;
    row.forEach((entry, index) => {
      const remainingHeight = Math.max(0, rect.y + rect.h - y);
      const height =
        index === row.length - 1 ? remainingHeight : Math.max(0, Math.min(remainingHeight, Number(entry.area || 0) / Math.max(1, rowWidth)));
      rects.push({ item: entry.item, rect: { x: rect.x, y, w: rowWidth, h: height }, depth });
      y += height;
    });
    return { x: rect.x + rowWidth, y: rect.y, w: Math.max(0, rect.w - rowWidth), h: rect.h };
  }
  const rowHeight = Math.max(0, Math.min(rect.h, area / Math.max(1, rect.w)));
  let x = rect.x;
  row.forEach((entry, index) => {
    const remainingWidth = Math.max(0, rect.x + rect.w - x);
    const width =
      index === row.length - 1 ? remainingWidth : Math.max(0, Math.min(remainingWidth, Number(entry.area || 0) / Math.max(1, rowHeight)));
    rects.push({ item: entry.item, rect: { x, y: rect.y, w: width, h: rowHeight }, depth });
    x += width;
  });
  return { x: rect.x, y: rect.y + rowHeight, w: rect.w, h: Math.max(0, rect.h - rowHeight) };
}

function splitSizeTreemapItems(items, rect, rects = [], depth = 0) {
  const positiveItems = items.filter((item) => Number(item.mapSize ?? sizeAnalysisTreemapValue(item)) > 0);
  const total = positiveItems.reduce((sum, item) => sum + Number(item.mapSize ?? sizeAnalysisTreemapValue(item)), 0);
  const area = Math.max(0, Number(rect.w || 0) * Number(rect.h || 0));
  if (!positiveItems.length || total <= 0 || area <= 0) {
    return rects;
  }
  const pending = positiveItems.map((item) => ({
    item,
    area: (Number(item.mapSize ?? sizeAnalysisTreemapValue(item)) / total) * area
  }));
  let remaining = { ...rect };
  let row = [];
  let rowDepth = 0;
  while (pending.length && remaining.w > 0.5 && remaining.h > 0.5) {
    const side = Math.min(remaining.w, remaining.h);
    const next = pending[0];
    const currentScore = sizeAnalysisTreemapWorstAspect(row, side);
    const nextScore = sizeAnalysisTreemapWorstAspect([...row, next], side);
    if (!row.length || nextScore <= currentScore) {
      row.push(next);
      pending.shift();
      continue;
    }
    remaining = pushSizeAnalysisTreemapRow(row, remaining, rects, depth + rowDepth);
    row = [];
    rowDepth += 1;
  }
  if (row.length && remaining.w > 0.5 && remaining.h > 0.5) {
    pushSizeAnalysisTreemapRow(row.concat(pending), remaining, rects, depth + rowDepth);
  }
  return rects;
}

function splitHierarchicalSizeTreemap(items, rect, rects = [], depth = 0) {
  const laidOut = splitSizeTreemapItems(items, rect, [], depth);
  for (const entry of laidOut) {
    const record = { item: entry.item, rect: entry.rect, depth };
    rects.push(record);
    const children = Array.isArray(entry.item?.children) ? entry.item.children : [];
    if (!entry.item?.treemapGroup || !children.length || depth >= 8 || entry.rect.w < 54 || entry.rect.h < 42) {
      continue;
    }
    const headerHeight = Math.min(23, Math.max(15, entry.rect.h * 0.13));
    const inner = {
      x: entry.rect.x + 3,
      y: entry.rect.y + headerHeight + 2,
      w: Math.max(0, entry.rect.w - 6),
      h: Math.max(0, entry.rect.h - headerHeight - 5)
    };
    if (inner.w >= 8 && inner.h >= 8) {
      splitHierarchicalSizeTreemap(children, inner, rects, depth + 1);
    }
  }
  return rects;
}

function sizeAnalysisTreemapRectAtPoint(canvas, event) {
  if (!canvas || !app.sizeAnalysis.treemapRects.length) {
    return null;
  }
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) {
    return null;
  }
  const cssWidth = parseFloat(canvas.style.width) || canvas.clientWidth || bounds.width;
  const cssHeight = parseFloat(canvas.style.height) || canvas.clientHeight || bounds.height;
  const x = (event.clientX - bounds.left) * (cssWidth / bounds.width);
  const y = (event.clientY - bounds.top) * (cssHeight / bounds.height);
  for (let index = app.sizeAnalysis.treemapRects.length - 1; index >= 0; index -= 1) {
    const item = app.sizeAnalysis.treemapRects[index];
    if (x >= item.x && y >= item.y && x <= item.x + item.w && y <= item.y + item.h) {
      return item;
    }
  }
  return null;
}

function setSizeAnalysisTreemapHover(item) {
  const nextKey = item?.key || "";
  const currentKey = app.sizeAnalysis.treemapHover?.key || "";
  if (nextKey === currentKey) {
    return;
  }
  app.sizeAnalysis.treemapHover = item || null;
  setSizeAnalysisMapDetail(item || null);
  requestAnimationFrame(() => drawSizeTreemap(app.sizeAnalysis.report));
}

function setSizeAnalysisTreemapSelection(item) {
  app.sizeAnalysis.treemapSelection = item || null;
  setSizeAnalysisMapDetail(app.sizeAnalysis.treemapHover || app.sizeAnalysis.treemapSelection);
  renderSizeAnalysisMapNavigation(app.sizeAnalysis.report);
  requestAnimationFrame(() => drawSizeTreemap(app.sizeAnalysis.report));
}

function updateSizeAnalysisTreemapHover(event) {
  const canvas = event.currentTarget || document.getElementById("size-analysis-treemap");
  const hit = sizeAnalysisTreemapRectAtPoint(canvas, event);
  canvas.title = hit ? `${hit.title}\n${hit.path || ""}` : "File size map";
  canvas.style.cursor = hit && !hit.virtualRemainder ? "pointer" : "crosshair";
  setSizeAnalysisTreemapHover(hit);
}

function clearSizeAnalysisTreemapHover() {
  const canvas = document.getElementById("size-analysis-treemap");
  if (canvas) {
    canvas.title = "File size map";
    canvas.style.cursor = "crosshair";
  }
  setSizeAnalysisTreemapHover(null);
}

async function openSizeAnalysisTreemapItem(item = app.sizeAnalysis.treemapHover) {
  if (!item || item.virtualRemainder || !item.path) {
    showToast("Choose a concrete file block");
    return;
  }
  if (item.treemapGroup) {
    await loadPane(app.activePane, item.path);
    setStatus(`Opened ${item.name || item.path} from nested file map`);
    return;
  }
  const parentPath = item.parent || parentPathOf(item.path);
  if (!parentPath) {
    return;
  }
  await loadPane(app.activePane, parentPath);
  if (selectPathInPane(app.activePane, item.path)) {
    renderPane(app.activePane);
    scrollFocusedEntryIntoView(app.activePane);
    renderInspector();
    updateSelectionReadout();
    setStatus(`Selected ${item.name || item.path} from file map`);
  }
}

function drawSizeTreemap(report) {
  const canvas = document.getElementById("size-analysis-treemap");
  if (!canvas) {
    return;
  }
  const panel = canvas.parentElement;
  const head = panel?.querySelector(".size-analysis-section-head");
  const detailRow = panel?.querySelector(".size-analysis-map-detail-row");
  const width = Math.max(360, (panel?.clientWidth || 1080) - 18);
  const availableHeight = panel ? panel.clientHeight - (head?.offsetHeight || 0) - (detailRow?.offsetHeight || 0) - 18 : 0;
  const height = Math.max(160, Math.min(560, availableHeight || Math.round(width * 0.36)));
  const ratio = window.devicePixelRatio || 1;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#101716";
  ctx.fillRect(0, 0, width, height);
  const hierarchy = sizeAnalysisTreemapHierarchy(report);
  const focused = sizeAnalysisTreemapFocusNode(hierarchy);
  renderSizeAnalysisMapNavigation(report, hierarchy);
  const measuredTotal =
    app.sizeAnalysis.sizeMode === "allocated"
      ? Number(report?.summary?.allocated || report?.summary?.bytes || 0)
      : Number(report?.summary?.bytes || 0);
  if (!focused?.children?.length || measuredTotal <= 0) {
    app.sizeAnalysis.treemapRects = [];
    ctx.fillStyle = "#dbe6e1";
    ctx.font = "600 14px Segoe UI, sans-serif";
    ctx.fillText(report ? "No mapped children in this folder" : "Scan to draw treemap", 18, 28);
    canvas.setAttribute(
      "aria-label",
      report
        ? `Hierarchical file size treemap focused on ${focused?.name || "folder"}. No mapped children.`
        : "Hierarchical file size treemap. Scan to draw nested file map."
    );
    return;
  }
  const rects = splitHierarchicalSizeTreemap(focused.children, { x: 0, y: 0, w: width, h: height });
  const hoverKey = app.sizeAnalysis.treemapHover?.key || "";
  const selectedKey = app.sizeAnalysis.treemapSelection?.key || "";
  app.sizeAnalysis.treemapRects = rects.map(({ item, rect, depth }) => ({
    key: sizeAnalysisTreemapKey(item),
    path: item.path || "",
    parent: item.parent || "",
    name: item.name || "",
    extension: item.extension || "",
    kind: item.kind || "",
    size: Number(item.size || 0),
    allocated: sizeAnalysisAllocatedOf(item),
    mapSize: Number(item.mapSize ?? sizeAnalysisTreemapValue(item)),
    folderColor: item.folderColor || "",
    virtualRemainder: item.virtualRemainder === true,
    treemapGroup: item.treemapGroup === true,
    depth: Number(depth || 0),
    title: sizeAnalysisTreemapLabel(item, report),
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h
  }));
  if (hoverKey && !app.sizeAnalysis.treemapRects.some((item) => item.key === hoverKey)) {
    app.sizeAnalysis.treemapHover = null;
    setSizeAnalysisMapDetail(null);
  }
  if (selectedKey && !app.sizeAnalysis.treemapRects.some((item) => item.key === selectedKey)) {
    app.sizeAnalysis.treemapSelection = null;
    setSizeAnalysisMapDetail(null);
  }
  const groupCount = app.sizeAnalysis.treemapRects.filter((item) => item.treemapGroup).length;
  const mappedFileCount = app.sizeAnalysis.treemapRects.length - groupCount;
  canvas.setAttribute(
    "aria-label",
    `Hierarchical file size treemap focused on ${focused.name || "scan root"} with ${mappedFileCount.toLocaleString()} mapped file block(s) inside ${groupCount.toLocaleString()} folder group(s), sized by ${app.sizeAnalysis.sizeMode} bytes and colored by ${
      app.sizeAnalysis.colorMode === "folder" ? "top folder" : "file type"
    }.`
  );
  const mapCount = document.getElementById("size-analysis-map-count");
  if (mapCount) {
    mapCount.textContent = `${groupCount.toLocaleString()} folders / ${mappedFileCount.toLocaleString()} files`;
  }
  rects.forEach((item, index) => {
    const { item: node, rect, depth } = item;
    if (!node || rect.w < 0.7 || rect.h < 0.7) return;
    const key = sizeAnalysisTreemapKey(node);
    const hovered = key === app.sizeAnalysis.treemapHover?.key;
    const selected = key === app.sizeAnalysis.treemapSelection?.key;
    const active = hovered || selected;
    if (node.treemapGroup) {
      ctx.fillStyle =
        app.sizeAnalysis.colorMode === "folder" ? sizeAnalysisTreemapColor(node) : active ? "#29443d" : "#182722";
      if (app.sizeAnalysis.colorMode === "folder" && !active) ctx.globalAlpha = 0.34;
      ctx.fillRect(rect.x + 0.5, rect.y + 0.5, Math.max(0, rect.w - 1), Math.max(0, rect.h - 1));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = selected ? "#f4c04d" : hovered ? "#ffffff" : depth === 0 ? "rgba(224,241,233,0.88)" : "rgba(175,211,199,0.72)";
      ctx.lineWidth = active ? 3 : depth === 0 ? 2 : 1.5;
      ctx.strokeRect(rect.x + 1, rect.y + 1, Math.max(0, rect.w - 2), Math.max(0, rect.h - 2));
      if (rect.w >= 96 && rect.h >= 34) {
        const headerHeight = Math.min(23, Math.max(15, rect.h * 0.13));
        ctx.fillStyle = "rgba(5,12,10,0.72)";
        ctx.fillRect(rect.x + 2, rect.y + 2, Math.max(0, rect.w - 4), Math.max(0, headerHeight - 2));
        ctx.fillStyle = "#f3faf6";
        ctx.font = depth === 0 ? "700 12px Segoe UI, sans-serif" : "700 11px Segoe UI, sans-serif";
        const folderLabel = `${node.name || "Folder"}  ${formatSize(node.mapSize ?? sizeAnalysisTreemapValue(node))}`;
        ctx.fillText(folderLabel, rect.x + 7, rect.y + Math.min(16, headerHeight - 3), Math.max(0, rect.w - 13));
      }
      ctx.lineWidth = 1;
      return;
    }
    ctx.fillStyle = sizeAnalysisTreemapColor(node);
    ctx.fillRect(rect.x + 0.7, rect.y + 0.7, Math.max(0, rect.w - 1.4), Math.max(0, rect.h - 1.4));
    const glow = Math.max(0.04, 0.18 - depth * 0.012);
    const gradient = ctx.createRadialGradient(
      rect.x + rect.w * 0.52,
      rect.y + rect.h * 0.45,
      1,
      rect.x + rect.w * 0.52,
      rect.y + rect.h * 0.45,
      Math.max(rect.w, rect.h)
    );
    gradient.addColorStop(0, `rgba(255,255,255,${glow})`);
    gradient.addColorStop(1, "rgba(0,0,0,0.18)");
    ctx.fillStyle = gradient;
    ctx.fillRect(rect.x + 0.7, rect.y + 0.7, Math.max(0, rect.w - 1.4), Math.max(0, rect.h - 1.4));
    ctx.strokeStyle = selected ? "#f4c04d" : hovered ? "rgba(255,255,255,0.95)" : "rgba(10,16,15,0.58)";
    ctx.lineWidth = active ? 2.5 : 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, Math.max(0, rect.w - 1), Math.max(0, rect.h - 1));
    ctx.lineWidth = 1;
    if (active) {
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.fillRect(rect.x + 2, rect.y + 2, Math.max(0, rect.w - 4), Math.min(28, Math.max(0, rect.h - 4)));
    }
    if (rect.w >= 86 && rect.h >= 38) {
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 12px Segoe UI, sans-serif";
      const label = String(node.name || "").slice(0, Math.max(4, Math.floor(rect.w / 8)));
      ctx.fillText(label, rect.x + 7, rect.y + 17, rect.w - 12);
      ctx.font = "600 11px Segoe UI, sans-serif";
      ctx.fillText(formatSize(node.mapSize ?? sizeAnalysisTreemapValue(node)), rect.x + 7, rect.y + 32, rect.w - 12);
    } else if (rect.w >= 40 && rect.h >= 24 && index < 80) {
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.font = "700 10px Segoe UI, sans-serif";
      ctx.fillText(sizeAnalysisExtensionLabel(node.extension), rect.x + 5, rect.y + 14, rect.w - 8);
    }
  });
}

function clipboardHasPath(itemPath) {
  return app.fileClipboard.mode === "move" && app.fileClipboard.paths.some((pathItem) => samePath(pathItem, itemPath));
}

function emptyFileClipboard() {
  return { mode: null, paths: [], sourcePane: null, sourcePath: null, capturedAt: null };
}

async function publishWindowsFileClipboard(mode, paths) {
  return request("/api/clipboard/files", {
    method: "POST",
    body: JSON.stringify({ mode, paths })
  });
}

async function readWindowsFileClipboard() {
  const result = await request("/api/clipboard/files");
  const paths = Array.isArray(result.paths) ? result.paths.filter(Boolean) : [];
  if (!paths.length) {
    return null;
  }
  return {
    mode: result.mode === "move" ? "move" : "copy",
    paths,
    sourcePane: null,
    sourcePath: null,
    capturedAt: new Date().toISOString(),
    source: "windows"
  };
}

async function clearWindowsFileClipboard() {
  return request("/api/clipboard/files/clear", { method: "POST" });
}

async function setFileClipboard(mode, paneName) {
  const paths = selectedPaths(paneName);
  if (!paths.length) {
    showToast("Select items first");
    return false;
  }
  const clipboardMode = mode === "move" ? "move" : "copy";
  app.fileClipboard = {
    mode: clipboardMode,
    paths,
    sourcePane: paneName,
    sourcePath: tabOf(paneName).path,
    capturedAt: new Date().toISOString()
  };
  renderAll();
  updateClipboardReadout();
  setStatus(clipboardSummaryText());
  showToast(`${clipboardModeLabel(mode)} ${paths.length} item(s)`);
  try {
    await publishWindowsFileClipboard(clipboardMode, paths);
    setStatus(`${clipboardSummaryText()} / Windows clipboard`);
  } catch (error) {
    console.warn("Windows file clipboard sync failed", error);
    setStatus(`${clipboardSummaryText()} / Windows clipboard unavailable`);
    showToast(`App clipboard set; Windows clipboard failed`);
  }
  return true;
}

async function copySelectionToClipboard(paneName) {
  return setFileClipboard("copy", paneName);
}

async function cutSelectionToClipboard(paneName) {
  return setFileClipboard("move", paneName);
}

async function clearFileClipboard() {
  app.fileClipboard = emptyFileClipboard();
  renderAll();
  updateClipboardReadout();
  try {
    await clearWindowsFileClipboard();
    showToast("Clipboard cleared");
  } catch (error) {
    console.warn("Windows file clipboard clear failed", error);
    showToast("App clipboard cleared; Windows clear failed");
  }
}

function clipboardHasSourceInTarget(paths, targetDir) {
  return paths.some((itemPath) => samePath(parentPathOf(itemPath), targetDir));
}

async function pasteFileClipboard(paneName) {
  let clipboard = app.fileClipboard;
  if (!clipboard.paths.length) {
    try {
      clipboard = (await readWindowsFileClipboard()) || clipboard;
    } catch (error) {
      console.warn("Windows file clipboard read failed", error);
      showToast("Clipboard is empty");
      return;
    }
  }
  if (!clipboard.paths.length) {
    return showToast("Clipboard is empty");
  }
  const targetDir = tabOf(paneName).path;
  if (clipboard.mode === "move" && clipboardHasSourceInTarget(clipboard.paths, targetDir)) {
    return showToast("Cut items are already in this folder");
  }
  const mode = clipboard.mode === "move" ? "move" : "copy";
  const conflictMode = currentPasteConflictMode();
  const payload = {
    paths: clipboard.paths,
    targetDir,
    mode,
    conflictMode
  };
  const plan = await request("/api/transfer/preview", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (!plan.canApply) {
    const blockers = plan.items.filter((item) =>
      ["invalid", "missing", "duplicate"].includes(item.status)
    );
    if (blockers.length) {
      openTransferDialogWithPaths(paneName, clipboard.paths, { targetDir, mode, conflictMode });
      showToast("Review paste conflicts");
      return;
    }
    const skipped = (plan.counts?.skip || 0) + (plan.counts?.unchanged || 0);
    showToast(skipped ? `Paste skipped ${skipped} item(s)` : "Nothing to paste");
    return;
  }
  const result = await request("/api/transfer", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  await Promise.all([refreshPane("left"), refreshPane("right")]);
  if (clipboard.mode === "move") {
    app.fileClipboard = emptyFileClipboard();
    try {
      await clearWindowsFileClipboard();
    } catch (error) {
      console.warn("Windows file clipboard clear failed", error);
    }
  }
  await syncStateAndChrome();
  updateClipboardReadout();
  renderAll();
  const count = result.transferred?.length || result.copied?.length || result.moved?.length || clipboard.paths.length;
  const skipped = result.skipped?.length || 0;
  const suffix = skipped ? ` / skipped ${skipped}` : "";
  showToast(`${clipboardModeLabel(clipboard.mode)} pasted ${count} item(s)${suffix}`);
}

function copyNamesTargetsForPane(paneName = app.activePane) {
  const tab = tabOf(paneName);
  const selection = selectedPaths(paneName);
  const paths = selection.length ? selection : [tab.path].filter(Boolean);
  return paths.map((itemPath) => {
    const entry = tab.entries.find((item) => samePath(item.path, itemPath));
    return {
      path: itemPath,
      name: entry?.name || labelForPath(itemPath),
      isDirectory: entry ? Boolean(entry.isDirectory) : itemPath === tab.path,
      kind: entry?.kind || (itemPath === tab.path ? "Folder" : "Path")
    };
  });
}

function pathStem(itemPath) {
  const name = labelForPath(itemPath);
  const dotAt = name.lastIndexOf(".");
  return dotAt > 0 ? name.slice(0, dotAt) : name;
}

function copyNameValue(target, format) {
  if (format === "name") return labelForPath(target.path);
  if (format === "stem") return pathStem(target.path);
  if (format === "parent") return parentPathOf(target.path);
  return target.path;
}

function quoteCopyNameValue(value, quoteMode) {
  const text = String(value ?? "");
  if (quoteMode === "double") {
    return `"${text.replaceAll('"', '""')}"`;
  }
  if (quoteMode === "single") {
    return `'${text.replaceAll("'", "''")}'`;
  }
  return text;
}

function copyNamesSeparatorValue(separator) {
  if (separator === "space") return " ";
  if (separator === "comma") return ", ";
  if (separator === "tab") return "\t";
  return "\n";
}

function copyNamesOptionsFromForm() {
  return {
    format: document.getElementById("copy-names-format")?.value || "path",
    separator: document.getElementById("copy-names-separator")?.value || "newline",
    quote: document.getElementById("copy-names-quote")?.value || "none"
  };
}

function buildCopyNamesText(options = copyNamesOptionsFromForm()) {
  const targets = app.copyNames?.targets || [];
  if (options.format === "json") {
    return JSON.stringify(targets.map((target) => target.path), null, 2);
  }
  if (options.format === "csv") {
    const rows = [["name", "path", "parent", "kind"]].concat(
      targets.map((target) => [labelForPath(target.path), target.path, parentPathOf(target.path), target.kind])
    );
    return rows
      .map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","))
      .join("\n");
  }
  return targets
    .map((target) => quoteCopyNameValue(copyNameValue(target, options.format), options.quote))
    .join(copyNamesSeparatorValue(options.separator));
}

function renderCopyNamesDialog(message = null) {
  const targets = app.copyNames?.targets || [];
  const summary = document.getElementById("copy-names-summary");
  if (summary) {
    summary.textContent = message || `${targets.length} target${targets.length === 1 ? "" : "s"}`;
  }
  const note = document.getElementById("copy-names-target-note");
  if (note) {
    note.textContent = app.copyNames?.fromSelection
      ? "Uses the active pane selection."
      : "No files selected; using the active folder.";
  }
  const list = document.getElementById("copy-names-target-list");
  if (list) {
    list.innerHTML = targets.length
      ? targets
          .map(
            (target) =>
              `<div class="copy-names-target-row">
                <span>${target.isDirectory ? "DIR" : "FILE"}</span>
                <strong title="${escapeHtml(target.path)}">${escapeHtml(target.name)}</strong>
                <small>${escapeHtml(target.path)}</small>
              </div>`
          )
          .join("")
      : `<div class="empty-state">No targets</div>`;
  }
  const preview = document.getElementById("copy-names-preview");
  if (preview) {
    preview.value = buildCopyNamesText();
  }
}

function openCopyNamesDialog(paneName = app.activePane) {
  const targets = copyNamesTargetsForPane(paneName);
  app.activePane = paneName;
  app.copyNames = {
    paneName,
    targets,
    fromSelection: selectedPaths(paneName).length > 0
  };
  document.getElementById("copy-names-format").value = "path";
  document.getElementById("copy-names-separator").value = "newline";
  document.getElementById("copy-names-quote").value = "none";
  renderCopyNamesDialog();
  document.getElementById("copy-names-dialog").showModal();
}

function applyCopyNamesPreset(preset) {
  document.getElementById("copy-names-format").value = preset;
  document.getElementById("copy-names-separator").value = "newline";
  document.getElementById("copy-names-quote").value = "none";
  renderCopyNamesDialog();
}

async function copyNamesToWindowsClipboard() {
  if (!app.copyNames?.targets?.length) {
    return showToast("No names to copy");
  }
  const text = buildCopyNamesText();
  const result = await request("/api/clipboard/text", {
    method: "POST",
    body: JSON.stringify({ text })
  });
  renderCopyNamesDialog(`Copied ${result.lines} line${result.lines === 1 ? "" : "s"}`);
  showToast(`Copied ${result.chars} character${result.chars === 1 ? "" : "s"}`);
  return result;
}

async function copyNamesQuick(paneName = app.activePane, format = "path") {
  app.copyNames = {
    paneName,
    targets: copyNamesTargetsForPane(paneName),
    fromSelection: selectedPaths(paneName).length > 0
  };
  const text = buildCopyNamesText({ format, separator: "newline", quote: "none" });
  if (!text) {
    return showToast("No names to copy");
  }
  const result = await request("/api/clipboard/text", {
    method: "POST",
    body: JSON.stringify({ text })
  });
  showToast(`Copied ${result.lines} path${result.lines === 1 ? "" : "s"}`);
}

function checksumTargetsForPane(paneName = app.activePane) {
  return copyNamesTargetsForPane(paneName);
}

function checksumOptionsFromForm() {
  return {
    algorithm: document.getElementById("checksums-algorithm")?.value || "sha256",
    format: document.getElementById("checksums-format")?.value || "manifest",
    maxHashBytes: Number(document.getElementById("checksums-max-hash")?.value || 128) * 1024 * 1024
  };
}

function checksumFormatExtension(format, algorithm = document.getElementById("checksums-algorithm")?.value || "sha256") {
  if (format === "csv") return "csv";
  if (format === "json") return "json";
  return algorithm;
}

function safeDownloadStem(value) {
  const stem = String(value || "checksums")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "checksums";
}

function checksumManifestFilename(report = app.checksums?.report) {
  const targets = app.checksums?.targets || [];
  const source =
    targets.length === 1 ? labelForPath(targets[0].path) : labelForPath(tabOf(app.checksums?.paneName || app.activePane).path);
  const stamp = new Date(report?.generatedAt || Date.now()).toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const extension = checksumFormatExtension(report?.format || checksumOptionsFromForm().format, report?.algorithm);
  return `${safeDownloadStem(source)}-${stamp}.${extension}`;
}

function checksumSummaryText(report) {
  if (!report) {
    const count = app.checksums?.targets?.length || 0;
    return `${count} target${count === 1 ? "" : "s"} ready`;
  }
  const summary = report.summary || {};
  if (report.verification) {
    return `OK ${summary.ok || 0} / mismatch ${summary.mismatch || 0} / missing ${summary.missing || 0} / skipped ${
      summary.skipped || 0
    }`;
  }
  return `Hashed ${summary.hashed || 0} / skipped ${summary.skipped || 0} / ${formatSize(summary.bytes || 0)}`;
}

function likelyChecksumManifestTarget(target) {
  const name = labelForPath(target?.path || "").toLowerCase();
  return /\.(sha256|sha1|md5|checksums|checksum|csv|json|txt)$/i.test(name);
}

function checksumManifestTarget() {
  const targets = app.checksums?.targets || [];
  return targets.find(likelyChecksumManifestTarget) || (targets.length === 1 ? targets[0] : null);
}

function renderChecksumsDialog(message = null) {
  const targets = app.checksums?.targets || [];
  const report = app.checksums?.report || null;
  const summary = document.getElementById("checksums-summary");
  if (summary) {
    summary.textContent = message || checksumSummaryText(report);
  }
  const note = document.getElementById("checksums-target-note");
  if (note) {
    const manifest = checksumManifestTarget();
    note.textContent = manifest
      ? `Verify reads ${manifest.name}; Generate hashes selected files.`
      : app.checksums?.fromSelection
        ? "Hashes selected files. Select a manifest file to verify."
        : "No selection; the active folder is listed as a skipped target.";
  }
  const list = document.getElementById("checksums-target-list");
  if (list) {
    list.innerHTML = targets.length
      ? targets
          .map(
            (target) =>
              `<div class="checksums-target-row">
                <span>${target.isDirectory ? "DIR" : "FILE"}</span>
                <strong title="${escapeHtml(target.path)}">${escapeHtml(target.name)}</strong>
                <small>${escapeHtml(target.path)}</small>
              </div>`
          )
          .join("")
      : `<div class="empty-state">No targets</div>`;
  }

  const resultRows = document.getElementById("checksums-results");
  if (resultRows) {
    const hashedRows = report?.verification
      ? (report.items || []).map((item) => {
          const status = String(item.status || "skipped").toUpperCase();
          const code = item.status === "ok" ? item.actualHash : item.status === "mismatch" ? item.actualHash : item.reason;
          const tail =
            item.status === "mismatch"
              ? `expected ${String(item.expectedHash || "").slice(0, 12)}`
              : item.size
                ? formatSize(item.size)
                : "";
          return `<div class="checksums-result-row ${escapeHtml(item.status || "skipped")}">
            <span>${escapeHtml(status === "MISMATCH" ? "BAD" : status === "MISSING" ? "MISS" : status)}</span>
            <strong title="${escapeHtml(item.path)}">${escapeHtml(item.name || labelForPath(item.path))}</strong>
            <code title="${escapeHtml(code || "")}">${escapeHtml(code || "")}</code>
            <small title="${escapeHtml(item.expectedHash || "")}">${escapeHtml(tail)}</small>
          </div>`;
        })
      : (report?.items || []).map(
          (item) =>
            `<div class="checksums-result-row">
              <span>OK</span>
              <strong title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</strong>
              <code title="${escapeHtml(item.hash)}">${escapeHtml(item.hash)}</code>
              <small>${formatSize(item.size)}</small>
            </div>`
        );
    const skippedRows = report?.verification
      ? []
      : (report?.skipped || []).map(
          (item) =>
            `<div class="checksums-result-row skipped">
              <span>SKIP</span>
              <strong title="${escapeHtml(item.path)}">${escapeHtml(item.name || labelForPath(item.path))}</strong>
              <code>${escapeHtml(item.reason || "Skipped")}</code>
              <small>${item.size ? formatSize(item.size) : ""}</small>
            </div>`
        );
    resultRows.innerHTML =
      hashedRows.length || skippedRows.length
        ? hashedRows.concat(skippedRows).join("")
        : `<div class="empty-state">Generate or verify to see checksum rows</div>`;
  }

  const preview = document.getElementById("checksums-preview");
  if (preview) {
    preview.value = report?.text || "";
    preview.placeholder = "Generate a manifest or verify a selected manifest to preview the checksum report.";
  }
}

function openChecksumsDialog(paneName = app.activePane) {
  const targets = checksumTargetsForPane(paneName);
  app.activePane = paneName;
  app.checksums = {
    paneName,
    targets,
    fromSelection: selectedPaths(paneName).length > 0,
    report: null
  };
  document.getElementById("checksums-algorithm").value = "sha256";
  document.getElementById("checksums-format").value = "manifest";
  document.getElementById("checksums-max-hash").value = "128";
  renderChecksumsDialog();
  document.getElementById("checksums-dialog").showModal();
}

async function runChecksumsReport() {
  if (!app.checksums?.targets?.length) {
    return showToast("Select files first");
  }
  renderChecksumsDialog("Hashing...");
  const report = await request("/api/checksums", {
    method: "POST",
    body: JSON.stringify({
      paths: app.checksums.targets.map((target) => target.path),
      ...checksumOptionsFromForm()
    })
  });
  app.checksums.report = report;
  renderChecksumsDialog();
  setStatus(checksumSummaryText(report));
  return report;
}

async function copyChecksumManifest() {
  const report = app.checksums?.report || (await runChecksumsReport());
  if (!report?.text) {
    return showToast("No checksum text to copy");
  }
  const result = await request("/api/clipboard/text", {
    method: "POST",
    body: JSON.stringify({ text: report.text })
  });
  renderChecksumsDialog(`Copied ${result.lines} line${result.lines === 1 ? "" : "s"}`);
  showToast(`Copied ${result.chars} character${result.chars === 1 ? "" : "s"}`);
  return result;
}

function downloadTextFile(text, filename, type = "text/plain") {
  const blob = new Blob([text], { type });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function downloadChecksumManifest() {
  const report = app.checksums?.report || (await runChecksumsReport());
  if (!report?.text) {
    return showToast("No checksum text to download");
  }
  const type = report.format === "json" ? "application/json" : report.format === "csv" ? "text/csv" : "text/plain";
  downloadTextFile(report.text, checksumManifestFilename(report), type);
  renderChecksumsDialog("Downloaded manifest");
  showToast("Checksum manifest downloaded");
}

async function verifyChecksumManifest() {
  const manifest = checksumManifestTarget();
  if (!manifest) {
    return showToast("Select one checksum manifest file first");
  }
  renderChecksumsDialog("Verifying...");
  const report = await request("/api/checksums/verify", {
    method: "POST",
    body: JSON.stringify({
      manifestPath: manifest.path,
      ...checksumOptionsFromForm()
    })
  });
  app.checksums.report = report;
  renderChecksumsDialog();
  setStatus(checksumSummaryText(report));
  return report;
}

function resetChecksumReportForOptions() {
  if (app.checksums) {
    app.checksums.report = null;
    renderChecksumsDialog("Options changed");
  }
}

function dragModeFromEvent(event) {
  return event.shiftKey ? "move" : "copy";
}

function dragModeLabel(mode) {
  return mode === "move" ? "Move" : "Copy";
}

function dataTransferTypes(dataTransfer) {
  return Array.from(dataTransfer?.types || []);
}

function dataTransferHasFiles(dataTransfer) {
  return dataTransferTypes(dataTransfer).includes("Files");
}

function droppedFilesFromDataTransfer(dataTransfer) {
  const files = Array.from(dataTransfer?.files || []);
  if (files.length) {
    return files;
  }
  return Array.from(dataTransfer?.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile?.())
    .filter(Boolean);
}

function pathForDroppedFile(file) {
  const bridge = window.exploreBetterDesktop;
  try {
    if (bridge?.getPathForFile) {
      return bridge.getPathForFile(file) || "";
    }
  } catch {
    return "";
  }
  return file?.path || "";
}

function pathsFromExternalDrop(dataTransfer) {
  return [...new Set(droppedFilesFromDataTransfer(dataTransfer).map(pathForDroppedFile).filter(Boolean))];
}

function startNativeFileDrag(event, paths) {
  const bridge = window.exploreBetterDesktop;
  if (!bridge?.startFileDrag) {
    return false;
  }
  try {
    event.preventDefault();
    return bridge.startFileDrag(paths);
  } catch (error) {
    console.warn("Native file drag failed", error);
    return false;
  }
}

function selectedPathsForDrag(paneName, entryPath, row) {
  const tab = tabOf(paneName);
  app.activePane = paneName;
  if (!tab.selected.has(entryPath)) {
    tab.selected = new Set([entryPath]);
    tab.focusedPath = entryPath;
    tab.anchorPath = entryPath;
    row?.classList.add("selected", "focused");
    row?.setAttribute("aria-selected", "true");
  } else {
    tab.focusedPath = entryPath;
    tab.anchorPath = entryPath;
  }
  updateActivePaneChrome();
  renderInspector();
  return selectedPaths(paneName);
}

function dropPaneNameFromTarget(target) {
  const list = target?.closest?.("[data-list]");
  const pane = target?.closest?.(".pane[data-pane]");
  const paneName = list?.dataset.list || pane?.dataset.pane;
  return isPaneName(paneName) ? paneName : null;
}

function clearDropTarget() {
  document.querySelectorAll(".file-list.drop-target").forEach((list) => {
    list.classList.remove("drop-target", "drop-copy", "drop-move");
    delete list.dataset.dropMode;
  });
}

function setDropTarget(paneName, mode) {
  clearDropTarget();
  const list = document.querySelector(`[data-list="${paneName}"]`);
  if (!list) {
    return;
  }
  list.classList.add("drop-target", mode === "move" ? "drop-move" : "drop-copy");
  list.dataset.dropMode = mode === "move" ? "Move here" : "Copy here";
}

function clearDragTransfer(options = {}) {
  clearDropTarget();
  document.body.classList.remove("is-dragging-files");
  document.body.classList.remove("is-dragging-tabs", "is-dragging-dock");
  document.querySelectorAll(".drag-source").forEach((element) => {
    element.classList.remove("drag-source");
  });
  document.querySelectorAll(".tab.drag-over, .command-dock [data-global-action].drag-over").forEach((element) => {
    element.classList.remove("drag-over");
  });
  app.dragTransfer = null;
  app.tabDrag = null;
  app.dockDrag = null;
  if (!options.keepStatus) {
    setStatus("Ready");
  }
}

function invalidDropReason(transfer, targetDir, mode) {
  if (!transfer?.paths?.length) {
    return "Nothing is being dragged";
  }
  if (transfer.paths.some((itemPath) => pathInsideFolder(targetDir, itemPath))) {
    return "Cannot drop a folder into itself";
  }
  if (mode === "move" && transfer.paths.every((itemPath) => samePath(parentPathOf(itemPath), targetDir))) {
    return "Dragged items are already in this folder";
  }
  return "";
}

function pathsForDrop(transfer, targetDir, mode) {
  if (mode !== "move") {
    return transfer.paths;
  }
  return transfer.paths.filter((itemPath) => !samePath(parentPathOf(itemPath), targetDir));
}

function handleEntryDragStart(event) {
  if (app.tabDrag || app.dockDrag) {
    return;
  }
  const row = event.target.closest?.("[data-entry-path]");
  if (!row || !event.dataTransfer) {
    return;
  }
  const paneName = row.dataset.pane;
  if (!isPaneName(paneName)) {
    return;
  }
  hideContextMenu();
  const paths = selectedPathsForDrag(paneName, row.dataset.entryPath, row);
  if (!paths.length) {
    event.preventDefault();
    return;
  }
  app.dragTransfer = {
    paneName,
    sourcePath: tabOf(paneName).path,
    startPath: row.dataset.entryPath,
    paths
  };
  event.dataTransfer.effectAllowed = "copyMove";
  event.dataTransfer.setData("text/plain", paths.join("\n"));
  event.dataTransfer.setData(
    "application/x-explore-better-paths",
    JSON.stringify(app.dragTransfer)
  );
  row.classList.add("drag-source");
  document.body.classList.add("is-dragging-files");
  updateSelectionReadout();
  const nativeDragStarted = startNativeFileDrag(event, paths);
  setStatus(
    nativeDragStarted
      ? `Drag ${paths.length} item(s): drop in Explore Better or Windows`
      : `Drag ${paths.length} item(s): drop to copy, hold Shift to move`
  );
}

function handleTabDragStart(event) {
  const tabElement = event.target.closest?.("[data-tab-shell]");
  if (!tabElement || !event.dataTransfer) {
    return false;
  }
  const paneName = tabElement.dataset.pane;
  const index = Number(tabElement.dataset.tabShell);
  if (!isPaneName(paneName) || !Number.isInteger(index)) {
    return false;
  }
  app.tabDrag = { paneName, fromIndex: index };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-explore-better-tab", JSON.stringify(app.tabDrag));
  event.dataTransfer.setData("text/plain", `tab:${paneName}:${index}`);
  tabElement.classList.add("drag-source");
  document.body.classList.add("is-dragging-tabs");
  setStatus("Drag tab to reorder");
  return true;
}

function tabDropTarget(event) {
  const tabElement = event.target.closest?.("[data-tab-shell]");
  if (!tabElement) {
    return null;
  }
  const paneName = tabElement.dataset.pane;
  const index = Number(tabElement.dataset.tabShell);
  return isPaneName(paneName) && Number.isInteger(index) ? { tabElement, paneName, index } : null;
}

function handleTabDragOver(event) {
  if (!app.tabDrag) {
    return false;
  }
  const target = tabDropTarget(event);
  if (!target || target.paneName !== app.tabDrag.paneName) {
    return false;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".tab.drag-over").forEach((element) => element.classList.remove("drag-over"));
  target.tabElement.classList.add("drag-over");
  return true;
}

function reorderArrayItem(items, fromIndex, toIndex) {
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

function activeIndexAfterReorder(activeIndex, fromIndex, toIndex) {
  if (activeIndex === fromIndex) {
    return toIndex;
  }
  if (fromIndex < activeIndex && toIndex >= activeIndex) {
    return activeIndex - 1;
  }
  if (fromIndex > activeIndex && toIndex <= activeIndex) {
    return activeIndex + 1;
  }
  return activeIndex;
}

function handleTabDrop(event) {
  if (!app.tabDrag) {
    return false;
  }
  const target = tabDropTarget(event);
  if (!target || target.paneName !== app.tabDrag.paneName) {
    return false;
  }
  event.preventDefault();
  const pane = panes[target.paneName];
  const fromIndex = app.tabDrag.fromIndex;
  const toIndex = target.index;
  if (fromIndex !== toIndex && pane.tabs[fromIndex]) {
    pane.tabs = reorderArrayItem(pane.tabs, fromIndex, toIndex);
    pane.activeTab = activeIndexAfterReorder(pane.activeTab, fromIndex, toIndex);
    renderPane(target.paneName);
    scheduleStateSave();
    showToast("Tabs reordered");
  }
  clearDragTransfer({ keepStatus: true });
  return true;
}

function handleDockDragStart(event) {
  const button = event.target.closest?.(".command-dock [data-global-action]");
  if (!button || !event.dataTransfer) {
    return false;
  }
  const actionId = button.dataset.globalAction;
  if (!toolbarActionIdSet.has(actionId)) {
    return false;
  }
  app.dockDrag = { actionId };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-explore-better-dock-action", actionId);
  event.dataTransfer.setData("text/plain", `dock:${actionId}`);
  button.classList.add("drag-source");
  document.body.classList.add("is-dragging-dock");
  setStatus("Drag dock button to reorder");
  return true;
}

function dockDropTarget(event) {
  const button = event.target.closest?.(".command-dock [data-global-action]");
  return button?.dataset.globalAction ? button : null;
}

function handleDockDragOver(event) {
  if (!app.dockDrag) {
    return false;
  }
  const target = dockDropTarget(event);
  if (!target) {
    return false;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  document
    .querySelectorAll(".command-dock [data-global-action].drag-over")
    .forEach((element) => element.classList.remove("drag-over"));
  target.classList.add("drag-over");
  return true;
}

async function handleDockDrop(event) {
  if (!app.dockDrag) {
    return false;
  }
  const target = dockDropTarget(event);
  if (!target) {
    return false;
  }
  event.preventDefault();
  const sourceId = app.dockDrag.actionId;
  const targetId = target.dataset.globalAction;
  const currentOrder = toolbarOrderList();
  const fromIndex = currentOrder.indexOf(sourceId);
  const toIndex = currentOrder.indexOf(targetId);
  if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
    await saveSettingsPatch({ toolbarOrder: reorderArrayItem(currentOrder, fromIndex, toIndex) }, { message: "Dock reordered" });
  }
  clearDragTransfer({ keepStatus: true });
  return true;
}

function handleEntryDragOver(event) {
  const hasInternalTransfer = Boolean(app.dragTransfer?.paths?.length);
  const hasExternalFiles = dataTransferHasFiles(event.dataTransfer);
  if (!hasInternalTransfer && !hasExternalFiles) {
    return;
  }
  const paneName = dropPaneNameFromTarget(event.target);
  if (!paneName) {
    clearDropTarget();
    return;
  }
  event.preventDefault();
  const mode = dragModeFromEvent(event);
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = mode;
  }
  setDropTarget(paneName, mode);
}

function handleEntryDragLeave(event) {
  if (!app.dragTransfer?.paths?.length && !dataTransferHasFiles(event.dataTransfer)) {
    return;
  }
  const pane = event.target.closest?.(".pane[data-pane]");
  if (pane && event.relatedTarget && pane.contains(event.relatedTarget)) {
    return;
  }
  clearDropTarget();
}

async function runDroppedFileTransfer({ paths, mode, targetDir, sourcePane, targetPane }) {
  const endpoint = mode === "move" ? "/api/move" : "/api/copy";
  const result = await request(endpoint, {
    method: "POST",
    body: JSON.stringify({ paths, targetDir })
  });
  const panesToRefresh = [...new Set([sourcePane, targetPane].filter(Boolean))];
  await Promise.all(panesToRefresh.map((item) => refreshPane(item)));
  await syncStateAndChrome();
  renderAll();
  const count = result.copied?.length || result.moved?.length || paths.length;
  const message = `${dragModeLabel(mode)} dropped ${count} item(s)`;
  showToast(message);
  setStatus(message);
  return result;
}

async function handleExternalFileDrop(event, paneName) {
  event.preventDefault();
  const mode = dragModeFromEvent(event);
  const targetDir = tabOf(paneName).path;
  const paths = pathsFromExternalDrop(event.dataTransfer);
  if (!paths.length) {
    showToast("Open the desktop app to drop Windows files");
    setStatus("Drop paths unavailable");
    return;
  }
  const reason = invalidDropReason({ paths }, targetDir, mode);
  if (reason) {
    showToast(reason);
    setStatus(reason);
    return;
  }
  await runDroppedFileTransfer({
    paths: pathsForDrop({ paths }, targetDir, mode),
    mode,
    targetDir,
    targetPane: paneName
  });
}

async function handleInternalFileDrop(event, paneName, transfer) {
  event.preventDefault();
  const mode = dragModeFromEvent(event);
  const targetDir = tabOf(paneName).path;
  const reason = invalidDropReason(transfer, targetDir, mode);
  if (reason) {
    clearDragTransfer({ keepStatus: true });
    showToast(reason);
    setStatus(reason);
    return;
  }

  const paths = pathsForDrop(transfer, targetDir, mode);
  await runDroppedFileTransfer({
    paths,
    mode,
    targetDir,
    sourcePane: transfer.paneName,
    targetPane: paneName
  });
}

async function handleEntryDrop(event) {
  const transfer = app.dragTransfer;
  const paneName = dropPaneNameFromTarget(event.target);
  if (!paneName) {
    if (transfer?.paths?.length) {
      clearDragTransfer({ keepStatus: true });
    }
    return;
  }
  if (!transfer?.paths?.length) {
    if (dataTransferHasFiles(event.dataTransfer)) {
      try {
        await handleExternalFileDrop(event, paneName);
      } catch (error) {
        showToast(error.message);
        setStatus("Drop failed");
      } finally {
        clearDropTarget();
      }
    }
    return;
  }
  try {
    await handleInternalFileDrop(event, paneName, transfer);
  } catch (error) {
    showToast(error.message);
    setStatus("Drop failed");
  } finally {
    clearDragTransfer({ keepStatus: true });
  }
}

function visibleEntries(paneName) {
  return visibleEntryData(tabOf(paneName)).entries;
}

function visibleIndex(entries, entryPath) {
  const cached = app.visibleEntryIndexes.get(entries);
  if (cached) {
    const index = cached.get(normalizedPathKey(entryPath));
    return Number.isInteger(index) ? index : -1;
  }
  return entries.findIndex((entry) => samePath(entry.path, entryPath));
}

function visiblePathSet(entries) {
  return app.visibleEntryPathSets.get(entries) || new Set(entries.map((entry) => entry.path));
}

function normalizedTypeaheadText(value) {
  return String(value || "").toLocaleLowerCase();
}

function typeaheadSearchText(value) {
  const text = normalizedTypeaheadText(value);
  if (text.length > 1 && [...text].every((character) => character === text[0])) {
    return text[0];
  }
  return text;
}

function typeaheadMatches(entries, query) {
  const prefixMatches = [];
  const containsMatches = [];
  for (const entry of entries) {
    const name = normalizedTypeaheadText(entry.name);
    if (name.startsWith(query)) {
      prefixMatches.push(entry);
    } else if (name.includes(query)) {
      containsMatches.push(entry);
    }
  }
  return prefixMatches.length ? prefixMatches : containsMatches;
}

function isTypeaheadKey(event) {
  return (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.length === 1 &&
    event.key !== " "
  );
}

function rangePaths(entries, anchorPath, entryPath) {
  const anchorIndex = visibleIndex(entries, anchorPath);
  const entryIndex = visibleIndex(entries, entryPath);
  if (anchorIndex === -1 || entryIndex === -1) {
    return [entryPath];
  }
  const start = Math.min(anchorIndex, entryIndex);
  const end = Math.max(anchorIndex, entryIndex);
  return entries.slice(start, end + 1).map((entry) => entry.path);
}

function usableAnchorPath(tab, entries, fallbackPath) {
  const paths = visiblePathSet(entries);
  if (tab.anchorPath && paths.has(tab.anchorPath)) {
    return tab.anchorPath;
  }
  if (tab.focusedPath && paths.has(tab.focusedPath)) {
    return tab.focusedPath;
  }
  const selectedPath = [...tab.selected].find((path) => paths.has(path));
  return selectedPath || fallbackPath;
}

function entryElementForPath(paneName, entryPath) {
  const list = document.querySelector(`[data-list="${paneName}"]`);
  if (!list || !entryPath) {
    return null;
  }
  if (window.CSS?.escape) {
    const direct = list.querySelector(`[data-entry-key="${CSS.escape(entryDomKey(entryPath))}"]`);
    if (direct) {
      return direct;
    }
  }
  return [...list.querySelectorAll("[data-entry-path]")].find(
    (element) => element.dataset.entryPath === entryPath
  );
}

function focusPaneList(paneName) {
  const list = document.querySelector(`[data-list="${paneName}"]`);
  if (list && document.activeElement !== list) {
    list.focus({ preventScroll: true });
  }
}

function scrollFocusedEntryIntoView(paneName) {
  const focusedPath = tabOf(paneName).focusedPath;
  const entryElement = entryElementForPath(paneName, focusedPath);
  if (entryElement) {
    entryElement.scrollIntoView({
      block: "nearest",
      inline: "nearest"
    });
    return;
  }
  scrollVirtualEntryIntoView(paneName, focusedPath);
}

function scrollVirtualEntryIntoView(paneName, entryPath) {
  const state = app.virtualLists[paneName];
  const list = document.querySelector(`[data-list="${paneName}"]`);
  if (!state || !list || !entryPath) {
    return;
  }
  const index = visibleIndex(state.entries, entryPath);
  if (index < 0) {
    return;
  }
  const metrics = virtualListMetrics(state.tab, list, state.entries.length);
  const rowIndex = Math.floor(index / metrics.columns);
  const rowTop = metrics.topPadding + rowIndex * metrics.rowHeight;
  const rowBottom = rowTop + metrics.itemHeight;
  const viewportTop = list.scrollTop;
  const viewportBottom = viewportTop + list.clientHeight;
  if (rowTop < viewportTop) {
    list.scrollTop = rowTop;
  } else if (rowBottom > viewportBottom) {
    list.scrollTop = Math.max(0, rowBottom - list.clientHeight);
  }
  renderVirtualFileWindow(paneName, true);
  entryElementForPath(paneName, entryPath)?.scrollIntoView({
    block: "nearest",
    inline: "nearest"
  });
}

function updatePaneSelectionDom(paneName) {
  const list = document.querySelector(`[data-list="${paneName}"]`);
  if (!list) {
    return;
  }
  const tab = tabOf(paneName);
  const focusedKey = entryDomKey(tab.focusedPath);
  const selectedKeys = new Set([...tab.selected].map(entryDomKey));
  if (tab.focusedPath) {
    list.setAttribute("aria-activedescendant", entryDomId(paneName, tab.focusedPath));
  } else {
    list.removeAttribute("aria-activedescendant");
  }
  list.querySelectorAll("[data-entry-path]").forEach((element) => {
    const selected = selectedKeys.has(element.dataset.entryKey);
    const focused = Boolean(focusedKey) && element.dataset.entryKey === focusedKey;
    element.classList.toggle("selected", selected);
    element.classList.toggle("focused", focused);
    element.setAttribute("aria-selected", selected ? "true" : "false");
  });
}

function commitSelectionChange(paneName, options = {}) {
  const activeChanged = app.activePane !== paneName;
  app.activePane = paneName;
  if (options.renderAll) {
    renderAll();
  } else {
    updatePaneSelectionDom(paneName);
  }
  if (activeChanged) {
    updateActivePaneChrome();
    renderRoots();
  } else {
    updatePaneActionAvailability(paneName);
    updateSelectionReadout();
  }
  renderInspector();
  if (options.focusList !== false) {
    focusPaneList(paneName);
  }
  if (options.scroll !== false) {
    scrollFocusedEntryIntoView(paneName);
  }
  if (options.prefetch !== false) {
    prefetchFocusedFolder(paneName, "focus");
  }
}

function clearSelection(paneName) {
  const tab = tabOf(paneName);
  tab.selected = new Set();
  tab.anchorPath = tab.focusedPath;
  commitSelectionChange(paneName);
}

function selectAll(paneName) {
  const tab = tabOf(paneName);
  const entries = visibleEntries(paneName);
  tab.selected = new Set(entries.map((entry) => entry.path));
  tab.focusedPath = tab.focusedPath && visiblePathSet(entries).has(tab.focusedPath)
    ? tab.focusedPath
    : entries[0]?.path || null;
  tab.anchorPath = entries[0]?.path || null;
  commitSelectionChange(paneName);
}

function invertSelection(paneName) {
  const tab = tabOf(paneName);
  const entries = visibleEntries(paneName);
  const inverted = entries
    .filter((entry) => !tab.selected.has(entry.path))
    .map((entry) => entry.path);
  tab.selected = new Set(inverted);
  tab.focusedPath = inverted[0] || entries[0]?.path || null;
  tab.anchorPath = tab.focusedPath;
  commitSelectionChange(paneName);
}

function wildcardMasks(patternText) {
  return String(patternText || "")
    .split(/[;,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function wildcardToRegExp(mask, caseSensitive = false) {
  const special = new Set(["|", "\\", "{", "}", "(", ")", "[", "]", "^", "$", "+", ".", "/"]);
  const pattern = [...String(mask || "")]
    .map((char) => {
      if (char === "*") {
        return ".*";
      }
      if (char === "?") {
        return ".";
      }
      return special.has(char) ? `\\${char}` : char;
    })
    .join("");
  return new RegExp(`^${pattern}$`, caseSensitive ? "" : "i");
}

function parseSelectSizeValue(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  const match = text.match(/^(\d+(?:\.\d+)?)\s*([kmgt]?b?|bytes?)?$/i);
  if (!match) {
    return NaN;
  }
  const units = {
    "": 1,
    b: 1,
    byte: 1,
    bytes: 1,
    k: 1024,
    kb: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4
  };
  const unit = String(match[2] || "").toLowerCase();
  return Number(match[1]) * (units[unit] || 1);
}

function entryComparableSize(entry) {
  const value = Number(entry?.size);
  return Number.isFinite(value) ? value : null;
}

function entryTimestamp(entry, field) {
  const raw = field === "created" ? entry?.created : entry?.modified;
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  const timestamp = Number(raw);
  if (Number.isFinite(timestamp)) {
    return timestamp;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function entryHasAttribute(entry, attribute) {
  if (attribute === "any") {
    return true;
  }
  const attrs = entry?.attributes || {};
  if (attribute === "none") {
    return !attributeText(entry);
  }
  if (attribute === "readonly") {
    return Boolean(attrs.readonly || entry?.readonly);
  }
  if (attribute === "hidden") {
    return Boolean(attrs.hidden || entry?.hidden);
  }
  if (attribute === "system") {
    return Boolean(attrs.system || entry?.system);
  }
  return Boolean(attrs[attribute] || entry?.[attribute]);
}

function selectMaskOptionsFromForm() {
  return {
    pattern: document.getElementById("select-pattern").value,
    mode: document.getElementById("select-mode").value,
    scope: document.getElementById("select-scope").value,
    caseSensitive: document.getElementById("select-case").checked,
    sizeOp: document.getElementById("select-size-op").value,
    sizeValue: document.getElementById("select-size-value").value,
    dateField: document.getElementById("select-date-field").value,
    dateOp: document.getElementById("select-date-op").value,
    dateDays: document.getElementById("select-date-days").value,
    attribute: document.getElementById("select-attribute").value
  };
}

function normalizedSelectPresetOptions(options = {}) {
  return {
    pattern: String(options.pattern || "").trim(),
    mode: ["replace", "add", "remove", "keep"].includes(options.mode) ? options.mode : "replace",
    scope: ["all", "files", "folders"].includes(options.scope) ? options.scope : "all",
    caseSensitive: Boolean(options.caseSensitive),
    sizeOp: ["any", "greater", "less", "equal"].includes(options.sizeOp) ? options.sizeOp : "any",
    sizeValue: options.sizeValue || "",
    dateField: options.dateField === "created" ? "created" : "modified",
    dateOp: ["any", "newer", "older"].includes(options.dateOp) ? options.dateOp : "any",
    dateDays: options.dateDays || "",
    attribute: [
      "any",
      "readonly",
      "hidden",
      "system",
      "archive",
      "compressed",
      "encrypted",
      "none"
    ].includes(options.attribute)
      ? options.attribute
      : "any"
  };
}

function applySelectOptionsToForm(options = {}) {
  const normalized = normalizedSelectPresetOptions(options);
  document.getElementById("select-pattern").value = normalized.pattern;
  document.getElementById("select-mode").value = normalized.mode;
  document.getElementById("select-scope").value = normalized.scope;
  document.getElementById("select-case").checked = normalized.caseSensitive;
  document.getElementById("select-size-op").value = normalized.sizeOp;
  document.getElementById("select-size-value").value = normalized.sizeValue;
  document.getElementById("select-date-field").value = normalized.dateField;
  document.getElementById("select-date-op").value = normalized.dateOp;
  document.getElementById("select-date-days").value = normalized.dateDays;
  document.getElementById("select-attribute").value = normalized.attribute;
  updateSelectMaskPreview();
}

function selectCriteriaLabel(options = {}) {
  const normalized = normalizedSelectPresetOptions(options);
  const parts = [];
  if (normalized.pattern) parts.push(normalized.pattern);
  if (normalized.scope !== "all") parts.push(normalized.scope);
  if (normalized.sizeOp !== "any") parts.push(`${normalized.sizeOp} ${normalized.sizeValue}`);
  if (normalized.dateOp !== "any") {
    parts.push(`${normalized.dateField} ${normalized.dateOp} ${normalized.dateDays}d`);
  }
  if (normalized.attribute !== "any") parts.push(`attr:${normalized.attribute}`);
  if (normalized.caseSensitive) parts.push("case");
  return parts.join(" / ") || "*";
}

function selectPresets() {
  if (!app.state) {
    return [];
  }
  if (!Array.isArray(app.state.selectPresets)) {
    app.state.selectPresets = [];
  }
  return app.state.selectPresets;
}

function currentSelectPreset() {
  const presets = selectPresets();
  return presets.find((preset) => preset.id === app.activeSelectPresetId) || presets[0] || null;
}

function defaultSelectPresetName(options = selectMaskOptionsFromForm()) {
  const label = selectCriteriaLabel(options);
  return label === "*" ? "Select Preset" : label.slice(0, 80);
}

function selectPresetDetail(preset) {
  if (!preset?.options) {
    return "";
  }
  const options = normalizedSelectPresetOptions(preset.options);
  return `${options.mode} / ${selectCriteriaLabel(options)}`;
}

function renderSelectPresets() {
  const select = document.getElementById("select-preset-select");
  if (!select) {
    return;
  }
  const presets = selectPresets();
  if ((!app.activeSelectPresetId || !presets.some((preset) => preset.id === app.activeSelectPresetId)) && presets[0]) {
    app.activeSelectPresetId = presets[0].id;
  }
  const active = currentSelectPreset();
  select.innerHTML = presets.length
    ? presets
        .map(
          (preset) =>
            `<option value="${escapeHtml(preset.id)}" ${preset.id === active?.id ? "selected" : ""}>${escapeHtml(
              preset.name
            )}</option>`
        )
        .join("")
    : `<option value="">No saved selections</option>`;
  document.getElementById("select-preset-name").value = active?.name || "";
  document.getElementById("select-preset-summary").textContent = active
    ? selectPresetDetail(active)
    : `${presets.length} presets`;
}

async function saveSelectPresetFromForm(replaceActive = false) {
  if (!app.state) {
    await loadState();
  }
  const options = normalizedSelectPresetOptions(selectMaskOptionsFromForm());
  const masks = wildcardMasks(options.pattern);
  const validation = selectRuleValidation(options, masks);
  if (!validation.valid) {
    showToast(validation.message);
    return null;
  }
  if (!validation.active) {
    showToast("Enter a mask or rule before saving");
    return null;
  }
  const existing = replaceActive ? currentSelectPreset() : null;
  if (replaceActive && !existing) {
    showToast("Select a preset first");
    return null;
  }
  const name =
    document.getElementById("select-preset-name").value.trim() ||
    existing?.name ||
    defaultSelectPresetName(options);
  const saved = {
    ...existing,
    id: existing?.id || crypto.randomUUID(),
    name,
    updatedAt: new Date().toISOString(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    options
  };
  app.state.selectPresets = [
    saved,
    ...selectPresets().filter((preset) => preset.id !== saved.id)
  ].slice(0, 50);
  app.activeSelectPresetId = saved.id;
  await saveStateNow();
  renderSelectPresets();
  renderBackupDialog();
  showToast(replaceActive ? "Select preset replaced" : "Select preset saved");
  return saved;
}

function applyActiveSelectPreset(runSelection = true) {
  const preset = currentSelectPreset();
  if (!preset) {
    return showToast("Save a select preset first");
  }
  applySelectOptionsToForm(preset.options);
  document.getElementById("select-preset-name").value = preset.name;
  document.getElementById("select-summary").textContent = `Preset: ${preset.name}`;
  if (runSelection) {
    applySelectMaskFromDialog();
  } else {
    showToast(`Loaded ${preset.name}`);
  }
}

async function deleteActiveSelectPreset() {
  const preset = currentSelectPreset();
  if (!preset) {
    return showToast("Select a preset first");
  }
  if (!confirm(`Delete select preset "${preset.name}"?`)) {
    return;
  }
  app.state.selectPresets = selectPresets().filter((item) => item.id !== preset.id);
  app.activeSelectPresetId = app.state.selectPresets[0]?.id || null;
  await saveStateNow();
  renderSelectPresets();
  renderBackupDialog();
  showToast("Select preset deleted");
}

function selectRuleValidation(options, masks) {
  const sizeOp = options.sizeOp || "any";
  const dateOp = options.dateOp || "any";
  const attribute = options.attribute || "any";
  const sizeBytes = parseSelectSizeValue(options.sizeValue);
  const dayCount = Number(options.dateDays);
  const hasSize = sizeOp !== "any";
  const hasDate = dateOp !== "any";
  const hasAttribute = attribute !== "any";
  const hasMask = masks.length > 0;
  if (hasSize && (!Number.isFinite(sizeBytes) || sizeBytes < 0)) {
    return { active: true, valid: false, message: "Enter a valid size", sizeBytes, dayCount };
  }
  if (hasDate && (!Number.isFinite(dayCount) || dayCount < 0)) {
    return { active: true, valid: false, message: "Enter a valid day count", sizeBytes, dayCount };
  }
  return {
    active: hasMask || hasSize || hasDate || hasAttribute,
    valid: true,
    message: "",
    sizeBytes,
    dayCount
  };
}

function entryMatchesMaskScope(entry, scope) {
  if (scope === "files") {
    return entry.isFile;
  }
  if (scope === "folders") {
    return entry.isDirectory;
  }
  return true;
}

function entryMatchesAdvancedRules(entry, options, validation) {
  if ((options.sizeOp || "any") !== "any") {
    const size = entryComparableSize(entry);
    if (size === null) {
      return false;
    }
    const target = validation.sizeBytes;
    if (options.sizeOp === "greater" && size <= target) {
      return false;
    }
    if (options.sizeOp === "less" && size >= target) {
      return false;
    }
    if (options.sizeOp === "equal" && size !== target) {
      return false;
    }
  }
  if ((options.dateOp || "any") !== "any") {
    const timestamp = entryTimestamp(entry, options.dateField);
    if (timestamp === null) {
      return false;
    }
    const cutoff = Date.now() - validation.dayCount * 24 * 60 * 60 * 1000;
    if (options.dateOp === "newer" && timestamp < cutoff) {
      return false;
    }
    if (options.dateOp === "older" && timestamp >= cutoff) {
      return false;
    }
  }
  return entryHasAttribute(entry, options.attribute || "any");
}

function maskMatchesForPane(paneName, options) {
  const masks = wildcardMasks(options.pattern);
  const validation = selectRuleValidation(options, masks);
  const entries = visibleEntries(paneName);
  if (!validation.valid || !validation.active) {
    return { masks, entries, matches: [], validation };
  }
  const regexes = masks.map((mask) => wildcardToRegExp(mask, options.caseSensitive));
  const matches = entries.filter((entry) =>
    entryMatchesMaskScope(entry, options.scope) &&
    (!regexes.length || regexes.some((regex) => regex.test(entry.name))) &&
    entryMatchesAdvancedRules(entry, options, validation)
  );
  return { masks, entries, matches, validation };
}

function selectionPreviewText(paneName, options) {
  const tab = tabOf(paneName);
  const { entries, matches, validation } = maskMatchesForPane(paneName, options);
  if (!validation.valid) {
    return { text: `${entries.length} visible / ${validation.message}`, matches };
  }
  if (!validation.active) {
    return { text: `${entries.length} visible / enter a mask or rule`, matches };
  }
  const current = selectedPaths(paneName).length;
  if (options.mode === "add") {
    const added = matches.filter((entry) => !tab.selected.has(entry.path)).length;
    return { text: `${matches.length} match / ${added} added / ${current} selected`, matches };
  }
  if (options.mode === "remove") {
    const removed = matches.filter((entry) => tab.selected.has(entry.path)).length;
    return { text: `${matches.length} match / ${removed} removed / ${current} selected`, matches };
  }
  if (options.mode === "keep") {
    const kept = matches.filter((entry) => tab.selected.has(entry.path)).length;
    return { text: `${matches.length} match / ${kept} kept / ${current} selected`, matches };
  }
  return { text: `${matches.length} match / ${entries.length} visible`, matches };
}

function selectPreviewMeta(entry, options) {
  const parts = [];
  const sizeText = entrySizeText(entry);
  if ((options.sizeOp || "any") !== "any" || sizeText) {
    parts.push(sizeText || "no size");
  }
  if ((options.dateOp || "any") !== "any") {
    const date = entryTimestamp(entry, options.dateField);
    parts.push(date === null ? "no date" : formatDate(date));
  }
  const attrs = attributeText(entry);
  if ((options.attribute || "any") !== "any" || attrs) {
    parts.push(attrs || "no attrs");
  }
  return parts.filter(Boolean).join(" / ") || entry.kind;
}

function updateSelectMaskPreview() {
  const paneName = app.selectMask?.paneName || app.activePane;
  const options = selectMaskOptionsFromForm();
  const preview = selectionPreviewText(paneName, options);
  document.getElementById("select-summary").textContent = `${paneName}: ${preview.text}`;
  document.getElementById("select-preview").innerHTML = preview.matches.length
    ? preview.matches
        .slice(0, 12)
        .map(
          (entry) =>
            `<div class="select-preview-row">
              <span class="glyph ${glyphFor(entry).className}">${escapeHtml(glyphFor(entry).text)}</span>
              <span title="${escapeHtml(entry.path)}">${escapeHtml(entry.name)}</span>
              <small>${escapeHtml(entry.kind)}</small>
              <small>${escapeHtml(selectPreviewMeta(entry, options))}</small>
            </div>`
        )
        .join("")
    : `<div class="empty-state">No matches</div>`;
}

function openSelectMaskDialog(paneName = app.activePane) {
  app.activePane = paneName;
  app.selectMask = {
    paneName,
    pattern: app.selectMask?.pattern || "",
    mode: app.selectMask?.mode || "replace",
    scope: app.selectMask?.scope || "all",
    caseSensitive: Boolean(app.selectMask?.caseSensitive),
    sizeOp: app.selectMask?.sizeOp || "any",
    sizeValue: app.selectMask?.sizeValue || "",
    dateField: app.selectMask?.dateField || "modified",
    dateOp: app.selectMask?.dateOp || "any",
    dateDays: app.selectMask?.dateDays || "",
    attribute: app.selectMask?.attribute || "any"
  };
  updateActivePaneChrome();
  applySelectOptionsToForm(app.selectMask);
  renderSelectPresets();
  updateSelectMaskPreview();
  document.getElementById("select-dialog").showModal();
  document.getElementById("select-pattern").focus();
}

function applySelectMaskFromDialog() {
  const paneName = app.selectMask?.paneName || app.activePane;
  const options = selectMaskOptionsFromForm();
  const { matches, validation } = maskMatchesForPane(paneName, options);
  if (!validation.valid) {
    showToast(validation.message);
    return;
  }
  if (!validation.active) {
    showToast("Enter a mask or rule");
    return;
  }
  const tab = tabOf(paneName);
  const matchPaths = matches.map((entry) => entry.path);
  const matchSet = new Set(matchPaths);
  const nextSelection = new Set(tab.selected);
  if (options.mode === "replace") {
    tab.selected = matchSet;
  } else if (options.mode === "add") {
    matchPaths.forEach((itemPath) => nextSelection.add(itemPath));
    tab.selected = nextSelection;
  } else if (options.mode === "remove") {
    matchPaths.forEach((itemPath) => nextSelection.delete(itemPath));
    tab.selected = nextSelection;
  } else {
    tab.selected = new Set([...tab.selected].filter((itemPath) => matchSet.has(itemPath)));
  }
  const selectedVisible = visibleEntries(paneName).find((entry) => tab.selected.has(entry.path));
  tab.focusedPath = selectedVisible?.path || matches[0]?.path || tab.focusedPath;
  tab.anchorPath = tab.focusedPath;
  app.selectMask = { ...app.selectMask, ...options };
  commitSelectionChange(paneName);
  updateSelectMaskPreview();
  showToast(`${selectedPaths(paneName).length} selected`);
}

function selectionSets() {
  if (!app.state) {
    app.state = {};
  }
  if (!Array.isArray(app.state.selectionSets)) {
    app.state.selectionSets = [];
  }
  return app.state.selectionSets;
}

function currentSelectionSet() {
  if (app.activeSelectionSetId === "__new__") {
    return null;
  }
  const sets = selectionSets();
  return sets.find((item) => item.id === app.activeSelectionSetId) || sets[0] || null;
}

function selectionSetMode() {
  const mode = document.getElementById("selection-set-mode")?.value;
  return ["replace", "add", "remove", "keep"].includes(mode) ? mode : "replace";
}

function defaultSelectionSetName(paneName = app.activePane) {
  const tab = tabOf(paneName);
  const count = selectedPaths(paneName).length;
  const suffix = count ? `${count} item${count === 1 ? "" : "s"}` : "Selection";
  return `${labelForPath(tab.path)} ${suffix}`.slice(0, 80);
}

function selectionSetDraftFromPane(paneName = app.activePane, existing = null) {
  const tab = tabOf(paneName);
  const paths = selectedPaths(paneName).slice(0, 1000);
  const entries = new Map(tab.entries.map((entry) => [normalizedPathKey(entry.path), entry]));
  const nameInput = (document.getElementById("selection-set-name")?.value || "").trim();
  const descriptionInput = (document.getElementById("selection-set-description")?.value || "").trim();
  return {
    ...existing,
    id: existing?.id || "",
    name: nameInput || existing?.name || defaultSelectionSetName(paneName),
    description: descriptionInput || existing?.description || "",
    path: tab.path,
    paths,
    items: paths.map((itemPath) => {
      const entry = entries.get(normalizedPathKey(itemPath));
      return {
        path: itemPath,
        name: entry?.name || labelForPath(itemPath),
        kind: entry?.kind || (entry?.isDirectory ? "Folder" : "Item"),
        isDirectory: Boolean(entry?.isDirectory),
        size: Number.isFinite(Number(entry?.size)) ? Number(entry.size) : null
      };
    })
  };
}

function selectionSetStats(selectionSet = currentSelectionSet(), paneName = app.activePane) {
  const entries = new Map(tabOf(paneName).entries.map((entry) => [normalizedPathKey(entry.path), entry]));
  const selected = new Set([...tabOf(paneName).selected].map(normalizedPathKey));
  const paths = selectionSet?.paths || [];
  const present = paths.filter((itemPath) => entries.has(normalizedPathKey(itemPath)));
  const selectedPresent = present.filter((itemPath) => selected.has(normalizedPathKey(itemPath)));
  return {
    total: paths.length,
    present: present.length,
    missing: Math.max(0, paths.length - present.length),
    selected: selectedPresent.length
  };
}

function fillSelectionSetForm(selectionSet = null) {
  document.getElementById("selection-set-id").value = selectionSet?.id || "";
  document.getElementById("selection-set-name").value =
    selectionSet?.name || defaultSelectionSetName(app.activePane);
  document.getElementById("selection-set-description").value = selectionSet?.description || "";
}

function selectionSetItemMeta(item) {
  const parts = [item.kind || "", item.size === null || item.size === undefined ? "" : formatSize(item.size)];
  return parts.filter(Boolean).join(" / ");
}

function renderSelectionSetsDialog(message = null) {
  const list = document.getElementById("selection-set-list");
  if (!list) {
    return;
  }
  const sets = selectionSets();
  if (
    app.activeSelectionSetId &&
    app.activeSelectionSetId !== "__new__" &&
    !sets.some((item) => item.id === app.activeSelectionSetId)
  ) {
    app.activeSelectionSetId = sets[0]?.id || null;
  }
  if (!app.activeSelectionSetId && sets[0]) {
    app.activeSelectionSetId = sets[0].id;
  }
  const active = currentSelectionSet();
  const summary = document.getElementById("selection-set-summary");
  if (summary) {
    const stats = active ? selectionSetStats(active) : null;
    summary.textContent =
      message || (active ? `${stats.present}/${stats.total} visible / ${sets.length} saved` : `${sets.length} saved`);
  }
  list.innerHTML = sets.length
    ? sets
        .map((selectionSet) => {
          const stats = selectionSetStats(selectionSet);
          const selected = selectionSet.id === active?.id ? " active" : "";
          return `<button type="button" class="${selected}" data-select-selection-set="${escapeHtml(selectionSet.id)}">
            <span>${escapeHtml(`${stats.present}/${stats.total}`)}</span>
            <strong>${escapeHtml(selectionSet.name || "Selection Set")}</strong>
            <small title="${escapeHtml(selectionSet.path)}">${escapeHtml(labelForPath(selectionSet.path))}</small>
            <small>${escapeHtml(selectionSet.description || formatDate(selectionSet.updatedAt))}</small>
          </button>`;
        })
        .join("")
    : `<div class="empty-state">No selection sets yet</div>`;
  fillSelectionSetForm(active);
  const detail = document.getElementById("selection-set-detail");
  if (!detail) {
    return;
  }
  if (!active) {
    detail.innerHTML = `<div class="empty-state">Save the current pane selection to reuse it later.</div>`;
    return;
  }
  const currentEntries = new Map(tabOf(app.activePane).entries.map((entry) => [normalizedPathKey(entry.path), entry]));
  const currentSelected = new Set([...tabOf(app.activePane).selected].map(normalizedPathKey));
  const rows = (active.items || active.paths.map((itemPath) => ({ path: itemPath, name: labelForPath(itemPath) })))
    .slice(0, 200)
    .map((item, index) => {
      const key = normalizedPathKey(item.path);
      const present = currentEntries.has(key);
      const selected = currentSelected.has(key);
      const status = selected ? "selected" : present ? "visible" : "missing";
      return `<div class="selection-set-row ${status}">
        <span>${index + 1}</span>
        <strong title="${escapeHtml(item.path)}">${escapeHtml(item.name || labelForPath(item.path))}</strong>
        <small>${escapeHtml(status)}</small>
        <small>${escapeHtml(selectionSetItemMeta(item))}</small>
      </div>`;
    })
    .join("");
  const overflow = active.paths.length > 200 ? `<div class="empty-state">${active.paths.length - 200} more</div>` : "";
  detail.innerHTML = `<div class="selection-set-path" title="${escapeHtml(active.path)}">${escapeHtml(active.path)}</div>${
    rows || `<div class="empty-state">No saved paths</div>`
  }${overflow}`;
}

async function saveSelectionSetFromCurrent(replaceActive = false) {
  if (!app.state) {
    await loadState();
  }
  const existing = replaceActive ? currentSelectionSet() : null;
  if (replaceActive && !existing) {
    return showToast("Select a set first");
  }
  const draft = selectionSetDraftFromPane(app.activePane, existing);
  if (!draft.paths.length) {
    return showToast("Select items first");
  }
  const now = new Date().toISOString();
  const saved = {
    ...draft,
    id: existing?.id || crypto.randomUUID(),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  app.state.selectionSets = [
    saved,
    ...selectionSets().filter((item) => item.id !== saved.id)
  ].slice(0, 100);
  app.activeSelectionSetId = saved.id;
  await saveStateNow();
  renderSelectionSetsDialog(replaceActive ? "Selection set replaced" : "Selection set saved");
  renderBackupDialog();
  showToast(replaceActive ? `Replaced ${saved.name}` : `Saved ${saved.name}`);
  return saved;
}

async function quickSaveSelectionSet(paneName = app.activePane) {
  app.activePane = paneName;
  return saveSelectionSetFromCurrent(false);
}

function newSelectionSetDraft() {
  app.activeSelectionSetId = "__new__";
  fillSelectionSetForm({
    name: defaultSelectionSetName(app.activePane),
    description: ""
  });
  renderSelectionSetsDialog("New set draft");
  document.getElementById("selection-set-name")?.focus();
}

async function applySelectionSet(openFirst = false) {
  const selectionSet = currentSelectionSet();
  if (!selectionSet) {
    return showToast("Select a selection set first");
  }
  const paneName = app.activePane;
  if (openFirst && selectionSet.path && !samePath(tabOf(paneName).path, selectionSet.path)) {
    await loadPane(paneName, selectionSet.path);
  }
  const tab = tabOf(paneName);
  const visible = new Map(tab.entries.map((entry) => [normalizedPathKey(entry.path), entry.path]));
  const presentPaths = (selectionSet.paths || [])
    .map((itemPath) => visible.get(normalizedPathKey(itemPath)))
    .filter(Boolean);
  if (!presentPaths.length) {
    renderSelectionSetsDialog("No saved items are visible here");
    return showToast("No saved items are visible here");
  }
  const mode = selectionSetMode();
  const presentSet = new Set(presentPaths);
  const nextSelection = new Set(tab.selected);
  if (mode === "replace") {
    tab.selected = presentSet;
  } else if (mode === "add") {
    presentPaths.forEach((itemPath) => nextSelection.add(itemPath));
    tab.selected = nextSelection;
  } else if (mode === "remove") {
    presentPaths.forEach((itemPath) => nextSelection.delete(itemPath));
    tab.selected = nextSelection;
  } else {
    tab.selected = new Set([...tab.selected].filter((itemPath) => presentSet.has(itemPath)));
  }
  tab.focusedPath = presentPaths[0] || tab.focusedPath;
  tab.anchorPath = tab.focusedPath;
  commitSelectionChange(paneName);
  renderSelectionSetsDialog(`${mode}: ${presentPaths.length} item(s)`);
  focusPaneList(paneName);
  showToast(`${selectedPaths(paneName).length} selected`);
}

async function deleteActiveSelectionSet() {
  const selectionSet = currentSelectionSet();
  if (!selectionSet) {
    return showToast("Select a set first");
  }
  if (!confirm(`Delete selection set "${selectionSet.name}"?`)) {
    return;
  }
  app.state.selectionSets = selectionSets().filter((item) => item.id !== selectionSet.id);
  app.activeSelectionSetId = app.state.selectionSets[0]?.id || null;
  await saveStateNow();
  renderSelectionSetsDialog("Selection set deleted");
  renderBackupDialog();
  showToast("Selection set deleted");
}

async function openSelectionSetsDialog(paneName = app.activePane) {
  app.activePane = paneName;
  await loadState();
  updateActivePaneChrome();
  renderSelectionSetsDialog();
  document.getElementById("selection-sets-dialog").showModal();
  document.getElementById("selection-set-name")?.focus();
}

function focusEntryAtIndex(paneName, targetIndex, options = {}) {
  const tab = tabOf(paneName);
  const entries = visibleEntries(paneName);
  if (!entries.length) {
    return;
  }
  const index = Math.max(0, Math.min(targetIndex, entries.length - 1));
  const entryPath = entries[index].path;
  tab.focusedPath = entryPath;

  if (options.extend) {
    const anchorPath = usableAnchorPath(tab, entries, entryPath);
    tab.anchorPath = anchorPath;
    tab.selected = new Set(rangePaths(entries, anchorPath, entryPath));
  } else if (!options.preserveSelection) {
    tab.anchorPath = entryPath;
    tab.selected = new Set([entryPath]);
  }

  commitSelectionChange(paneName);
}

function focusEntryByDelta(paneName, delta, options = {}) {
  const tab = tabOf(paneName);
  const entries = visibleEntries(paneName);
  if (!entries.length) {
    return;
  }
  const paths = visiblePathSet(entries);
  const selectedPath = [...tab.selected].find((path) => paths.has(path));
  const basePath = paths.has(tab.focusedPath) ? tab.focusedPath : selectedPath;
  const baseIndex = basePath ? visibleIndex(entries, basePath) : delta >= 0 ? -1 : entries.length;
  focusEntryAtIndex(paneName, baseIndex + delta, options);
}

function clearTypeahead() {
  app.typeahead = { paneName: null, value: "", lastAt: 0 };
}

function handleTypeaheadKey(event, paneName) {
  if (!isTypeaheadKey(event)) {
    return false;
  }

  const entries = visibleEntries(paneName);
  if (!entries.length) {
    return false;
  }

  event.preventDefault();
  const now = Date.now();
  const previous =
    app.typeahead?.paneName === paneName && now - Number(app.typeahead.lastAt || 0) < 900
      ? app.typeahead.value || ""
      : "";
  const value = `${previous}${event.key}`.slice(-48);
  const query = typeaheadSearchText(value);
  app.typeahead = { paneName, value, lastAt: now };

  const matches = typeaheadMatches(entries, query);
  if (!matches.length) {
    setStatus(`${paneName}: no match for ${value}`);
    return true;
  }

  const tab = tabOf(paneName);
  const currentIndex = visibleIndex(entries, tab.focusedPath);
  const shouldCycle = Boolean(previous) && query.length === 1;
  const target =
    shouldCycle && currentIndex !== -1
      ? matches.find((entry) => visibleIndex(entries, entry.path) > currentIndex) || matches[0]
      : matches[0];

  tab.focusedPath = target.path;
  tab.anchorPath = target.path;
  tab.selected = new Set([target.path]);
  commitSelectionChange(paneName);
  setStatus(`${paneName}: ${value} -> ${target.name}`);
  return true;
}

function openFocusedOrSelected(paneName) {
  const target = focusedOrSelectedEntry(paneName);
  if (!target) {
    return null;
  }
  return openEntry(paneName, target.path);
}

function focusedOrSelectedEntry(paneName) {
  const tab = tabOf(paneName);
  const entries = visibleEntries(paneName);
  const paths = visiblePathSet(entries);
  const targetPath = paths.has(tab.focusedPath)
    ? tab.focusedPath
    : [...tab.selected].find((path) => paths.has(path));
  return targetPath ? entryForPath(paneName, targetPath) : null;
}

async function openFocusedOrSelectedInNewTab(paneName) {
  const target = focusedOrSelectedEntry(paneName);
  if (!target?.isDirectory) {
    showToast("Select a folder to open in a new tab");
    return false;
  }
  return openFolderInNewTab(paneName, target.path);
}

function focusPathInput(paneName) {
  document.querySelector(`[data-path-input="${paneName}"]`)?.focus();
}

function focusFilterInput(paneName) {
  document.querySelector(`[data-filter="${paneName}"]`)?.focus();
}

function quickSearchPanel(paneName) {
  return document.querySelector(`[data-quick-search-panel="${paneName}"]`);
}

function quickSearchInput(paneName) {
  return document.querySelector(`[data-quick-search-input="${paneName}"]`);
}

function quickSearchMatches(paneName, query = app.quickSearch.query) {
  const text = normalizedTypeaheadText(query).trim();
  if (!text) {
    return [];
  }
  return typeaheadMatches(visibleEntries(paneName), text);
}

function renderQuickSearch() {
  for (const paneName of ["left", "right"]) {
    const panel = quickSearchPanel(paneName);
    if (!panel) {
      continue;
    }
    const active = app.quickSearch.paneName === paneName;
    panel.hidden = !active;
    if (!active) {
      continue;
    }
    const input = quickSearchInput(paneName);
    if (input && input.value !== app.quickSearch.query) {
      input.value = app.quickSearch.query;
    }
    panel.querySelectorAll("[data-quick-search-mode]").forEach((button) => {
      button.classList.toggle("active", button.dataset.quickSearchMode === app.quickSearch.mode);
    });
    const count = panel.querySelector("[data-quick-search-count]");
    if (count) {
      const matches = quickSearchMatches(paneName);
      count.textContent = app.quickSearch.query
        ? `${matches.length} match${matches.length === 1 ? "" : "es"}`
        : "Ready";
    }
  }
}

function closeQuickSearch() {
  app.quickSearch = { paneName: null, mode: "filter", query: "", activeIndex: 0 };
  document.querySelectorAll("[data-quick-search-panel]").forEach((panel) => {
    panel.hidden = true;
  });
  focusPaneList(app.activePane);
}

function openQuickSearch(paneName = app.activePane, mode = "filter") {
  if (!isPaneName(paneName)) {
    return false;
  }
  app.activePane = paneName;
  const tab = tabOf(paneName);
  app.quickSearch = {
    paneName,
    mode: mode === "jump" ? "jump" : "filter",
    query: app.quickSearch?.paneName === paneName ? app.quickSearch.query : tab.filter || "",
    activeIndex: 0
  };
  renderQuickSearch();
  requestAnimationFrame(() => {
    const input = quickSearchInput(paneName);
    input?.focus();
    input?.select();
  });
  return true;
}

function focusQuickSearchMatch(paneName, delta = 0) {
  const matches = quickSearchMatches(paneName);
  if (!matches.length) {
    setStatus(`${paneName}: no quick-search matches`);
    return false;
  }
  const nextIndex = (Number(app.quickSearch.activeIndex || 0) + delta + matches.length) % matches.length;
  app.quickSearch.activeIndex = nextIndex;
  const tab = tabOf(paneName);
  const entry = matches[nextIndex];
  tab.focusedPath = entry.path;
  tab.anchorPath = entry.path;
  tab.selected = new Set([entry.path]);
  commitSelectionChange(paneName);
  renderQuickSearch();
  setStatus(`${paneName}: ${nextIndex + 1}/${matches.length} ${entry.name}`);
  return true;
}

function applyQuickSearchQuery(paneName, query) {
  app.quickSearch.query = String(query || "");
  app.quickSearch.activeIndex = 0;
  if (app.quickSearch.mode === "filter") {
    const tab = tabOf(paneName);
    tab.filter = app.quickSearch.query;
    renderPane(paneName);
    renderQuickSearch();
    scheduleStateSave();
  } else {
    renderQuickSearch();
    if (app.quickSearch.query) {
      focusQuickSearchMatch(paneName, 0);
    }
  }
}

function setQuickSearchMode(paneName, mode) {
  app.quickSearch.paneName = paneName;
  app.quickSearch.mode = mode === "jump" ? "jump" : "filter";
  app.quickSearch.activeIndex = 0;
  if (app.quickSearch.mode === "filter") {
    tabOf(paneName).filter = app.quickSearch.query;
    renderPane(paneName);
    renderQuickSearch();
    scheduleStateSave();
  } else {
    renderQuickSearch();
    if (app.quickSearch.query) {
      focusQuickSearchMatch(paneName, 0);
    }
  }
}

function handleQuickSearchKey(event) {
  const input = event.target.closest?.("[data-quick-search-input]");
  if (!input) {
    return false;
  }
  const paneName = input.dataset.quickSearchInput;
  if (!isPaneName(paneName)) {
    return false;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeQuickSearch();
    return true;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (app.quickSearch.mode === "jump") {
      focusQuickSearchMatch(paneName, event.shiftKey ? -1 : 1);
      return true;
    }
    openFocusedOrSelected(paneName);
    return true;
  }
  if (event.key === "ArrowDown" || event.key === "F3") {
    event.preventDefault();
    focusQuickSearchMatch(paneName, 1);
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    focusQuickSearchMatch(paneName, -1);
    return true;
  }
  return false;
}

function pageStepForPane(paneName) {
  const tab = tabOf(paneName);
  const virtualState = app.virtualLists[paneName];
  const virtualList = document.querySelector(`[data-list="${paneName}"]`);
  if (virtualState && virtualList) {
    const rows = Math.max(1, Math.floor((virtualList.clientHeight || virtualState.rowHeight) / virtualState.rowHeight) - 1);
    return rows * Math.max(1, virtualState.columns || 1);
  }
  if (tab.viewMode === "compact") {
    return 16;
  }
  if (tab.viewMode !== "tiles") {
    return 12;
  }
  const list = document.querySelector(`[data-list="${paneName}"]`);
  const tile = list?.querySelector("[data-entry-path]");
  if (!list || !tile) {
    return 12;
  }
  const gap = Number.parseFloat(getComputedStyle(list).columnGap || "10") || 10;
  const tileWidth = tile.getBoundingClientRect().width + gap;
  const columns = Math.max(1, Math.floor(list.clientWidth / Math.max(tileWidth, 1)));
  return columns * 3;
}

function updateActivePaneChrome() {
  document.querySelectorAll(".pane[data-pane]").forEach((paneElement) => {
    paneElement.classList.toggle("active", paneElement.dataset.pane === app.activePane);
  });
  renderLayoutChrome();
  updateDualPaneActionChrome();
  updateSelectionReadout();
}

function itemWord(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summarizeEntrySet(entries) {
  const files = entries.filter((entry) => entry.isFile).length;
  const folders = entries.filter((entry) => entry.isDirectory).length;
  const other = Math.max(0, entries.length - files - folders);
  const bytes = entries.reduce(
    (total, entry) => total + (entry.isFile && Number.isFinite(entry.size) ? Number(entry.size) : 0),
    0
  );
  return { files, folders, other, bytes };
}

function selectionStatusForPane(paneName) {
  const tab = tabOf(paneName);
  const visible = visibleEntries(paneName);
  const selected = selectedEntries(paneName);
  const entries = selected.length ? selected : visible;
  const summary = summarizeEntrySet(entries);
  const partialLoading = tab.listingWindow?.hasMore === true;
  const partialTotalKnown = partialLoading && tab.listingWindow?.totalKnown !== false && Number.isFinite(Number(tab.listingWindow.total));
  const partialTotal = partialTotalKnown ? Number(tab.listingWindow.total) : 0;
  const visibleText = partialLoading
    ? partialTotalKnown
      ? `${visible.length.toLocaleString()}/${partialTotal.toLocaleString()} loaded`
      : `${visible.length.toLocaleString()}+ loading`
    : visible.length === tab.entries.length
      ? itemWord(visible.length, "item")
      : `${visible.length}/${tab.entries.length} visible`;
  const scopeText = selected.length ? `${selected.length} selected` : visibleText;
  const mix = [
    summary.files ? itemWord(summary.files, "file") : "",
    summary.folders ? itemWord(summary.folders, "folder") : "",
    summary.other ? itemWord(summary.other, "other") : ""
  ].filter(Boolean);
  const byteText = summary.files ? `${formatSize(summary.bytes)} files` : "";
  const detail = [mix.join(" / "), byteText].filter(Boolean).join(" / ") || "empty";
  const title = [
    `${paneName}: ${tab.path}`,
    selected.length
      ? `${selected.length} selected`
      : partialLoading
        ? partialTotalKnown
          ? `${visible.length} visible of ${partialTotal} loading`
          : `${visible.length} visible while total loads`
        : `${visible.length} visible of ${tab.entries.length}`,
    detail
  ].join("\n");
  return { active: selected.length > 0, detail, scopeText, title };
}

function updateSelectionReadout() {
  const readout = document.getElementById("selection-readout");
  if (!readout) {
    return;
  }
  const status = selectionStatusForPane(app.activePane);
  const paneLabel = app.activePane.toUpperCase();
  readout.classList.toggle("active", status.active);
  readout.title = status.title;
  readout.setAttribute(
    "aria-label",
    `${paneLabel} pane, ${status.scopeText}. ${status.detail}. Activate to focus the active file list.`
  );
  readout.innerHTML = `<img class="dock-status-icon" src="/icons/list-checks.svg" alt="" aria-hidden="true" />
    <span class="dock-status-main"><strong>${escapeHtml(paneLabel)}</strong><span class="dock-status-value">${escapeHtml(
      status.scopeText
    )}</span></span>`;
}

function clipboardModeLabel(mode = app.fileClipboard.mode) {
  return mode === "move" ? "Cut" : "Copy";
}

function clipboardSummaryText() {
  const count = app.fileClipboard.paths.length;
  if (!count) {
    return "Clipboard empty";
  }
  const label = clipboardModeLabel();
  const suffix = count === 1 ? labelForPath(app.fileClipboard.paths[0]) : `${count} items`;
  return `${label}: ${suffix}`;
}

function updateClipboardReadout() {
  const readout = document.getElementById("clipboard-readout");
  if (readout) {
    const count = app.fileClipboard.paths.length;
    const summary = clipboardSummaryText();
    const compact = count ? `${clipboardModeLabel()} ${count.toLocaleString()}` : "Empty";
    readout.title = summary;
    readout.setAttribute("aria-label", summary);
    readout.innerHTML = `<img class="dock-status-icon" src="/icons/clipboard.svg" alt="" aria-hidden="true" />
      <span class="dock-status-value">${escapeHtml(compact)}</span>`;
    readout.classList.toggle("active", Boolean(count));
    readout.classList.toggle("cut", app.fileClipboard.mode === "move");
  }
}

function normalizedKnownSettings(source = app.state?.settings || {}) {
  return {
    density: normalizeDensity(source.density),
    openGesture: normalizeOpenGesture(source.openGesture),
    startupMode: normalizeStartupMode(source.startupMode),
    startupLayoutId: normalizeReferenceId(source.startupLayoutId),
    focusMode: source.focusMode === true,
    navigator: source.navigator !== false,
    inspector: source.inspector !== false,
    inspectorAutoCollapse: source.inspectorAutoCollapse !== false,
    confirmTrash: source.confirmTrash !== false,
    launchMode: normalizeLaunchMode(source.launchMode),
    shellOpenMode: normalizeShellOpenMode(source.shellOpenMode),
    pasteConflictMode: normalizeConflictMode(source.pasteConflictMode),
    autoRefresh: source.autoRefresh !== false,
    showHidden: source.showHidden !== false,
    linkedNavigation: source.linkedNavigation === true,
    layoutSizes: normalizeLayoutSizes(source.layoutSizes),
    toolbarActions: normalizeToolbarActions(source.toolbarActions),
    toolbarOrder: normalizeToolbarOrder(source.toolbarOrder)
  };
}

function currentSettings() {
  return normalizedKnownSettings(app.state?.settings || {});
}

function inspectorEnabled() {
  return currentSettings().inspector;
}

function inspectorShouldAutoCollapse() {
  return inspectorEnabled() && currentSettings().inspectorAutoCollapse && selectedPaths(app.activePane).length === 0;
}

function applyInspectorPresence() {
  const shell = document.querySelector(".app-shell");
  if (!shell) {
    return;
  }
  const collapsed = inspectorShouldAutoCollapse() && !currentSettings().focusMode;
  const changed = shell.classList.toggle("inspector-auto-collapsed", collapsed);
  const inspector = document.getElementById("inspector");
  inspector?.classList.toggle("auto-collapsed", collapsed);
  if (inspector) {
    inspector.setAttribute("aria-label", collapsed ? "Preview, waiting for a selection" : "Preview");
  }
  if (changed) {
    for (const paneName of ["left", "right"]) {
      if (app.virtualLists[paneName]) {
        scheduleVirtualFileRender(paneName);
      }
    }
  }
}

function navigatorEnabled() {
  return currentSettings().navigator;
}

function confirmTrashEnabled() {
  return currentSettings().confirmTrash;
}

function applyLayoutSizeVariables(sizes = currentSettings().layoutSizes) {
  const shell = document.querySelector(".app-shell");
  if (!shell) {
    return;
  }
  const normalized = normalizeLayoutSizes(sizes);
  shell.style.setProperty("--nav-width", `${normalized.navWidth}px`);
  shell.style.setProperty("--inspector-width", `${normalized.inspectorWidth}px`);
  shell.style.setProperty("--left-pane-fr", `${normalized.leftPaneWeight}fr`);
  shell.style.setProperty("--right-pane-fr", `${normalized.rightPaneWeight}fr`);
  shell.style.setProperty("--top-pane-fr", `${normalized.topPaneWeight}fr`);
  shell.style.setProperty("--bottom-pane-fr", `${normalized.bottomPaneWeight}fr`);
  const focusedDock = normalizeToolbarActions(currentSettings().toolbarActions).length === 0;
  shell.classList.toggle("dock-focused", focusedDock);
  shell.style.setProperty("--user-dock-height", `${normalized.dockHeight}px`);
  for (const paneName of ["left", "right"]) {
    if (app.virtualLists[paneName]) {
      scheduleVirtualFileRender(paneName);
    }
  }
}

function resizeWeightPair(primaryPixels, secondaryPixels, delta, minPixels, primaryWeight, secondaryWeight) {
  const totalPixels = Math.max(primaryPixels + secondaryPixels, minPixels * 2);
  const nextPrimaryPixels = clampNumber(primaryPixels + delta, minPixels, totalPixels - minPixels, primaryPixels);
  const nextSecondaryPixels = totalPixels - nextPrimaryPixels;
  const totalWeight = Math.max(0.9, Number(primaryWeight || 1) + Number(secondaryWeight || 1));
  return {
    primary: clampNumber((nextPrimaryPixels / totalPixels) * totalWeight, 0.45, 3.5, 1),
    secondary: clampNumber((nextSecondaryPixels / totalPixels) * totalWeight, 0.45, 3.5, 1)
  };
}

function beginLayoutResize(event, kind) {
  if (event.button !== 0) {
    return false;
  }
  const leftPane = document.querySelector('.pane[data-pane="left"]');
  const rightPane = document.querySelector('.pane[data-pane="right"]');
  const settings = currentSettings();
  const sizes = normalizeLayoutSizes(settings.layoutSizes);
  const leftRect = leftPane?.getBoundingClientRect();
  const rightRect = rightPane?.getBoundingClientRect();
  app.layoutResize = {
    kind,
    pointerId: event.pointerId,
    handle: event.target.closest("[data-layout-resize]"),
    startX: event.clientX,
    startY: event.clientY,
    startSizes: sizes,
    currentSizes: sizes,
    leftWidth: leftRect?.width || 0,
    rightWidth: rightRect?.width || 0,
    topHeight: leftRect?.height || 0,
    bottomHeight: rightRect?.height || 0,
    frame: null,
    pendingSizes: null
  };
  app.layoutResize.handle?.setPointerCapture?.(event.pointerId);
  app.layoutResize.handle?.classList.add("dragging");
  document.body.classList.add("resizing-layout");
  document.body.classList.toggle("resizing-rows", kind === "paneRows" || kind === "dock");
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function applyLayoutResizeDraft(sizes) {
  const session = app.layoutResize;
  if (!session) {
    return;
  }
  session.currentSizes = normalizeLayoutSizes(sizes);
  session.pendingSizes = session.currentSizes;
  if (session.frame) {
    return;
  }
  session.frame = requestAnimationFrame(() => {
    const active = app.layoutResize;
    if (!active) {
      return;
    }
    active.frame = null;
    applyLayoutSizeVariables(active.pendingSizes || active.currentSizes);
  });
}

function updateLayoutResize(event) {
  const session = app.layoutResize;
  if (!session || event.pointerId !== session.pointerId) {
    return;
  }
  const dx = event.clientX - session.startX;
  const dy = event.clientY - session.startY;
  const sizes = { ...session.startSizes };
  if (session.kind === "nav") {
    sizes.navWidth = clampNumber(session.startSizes.navWidth + dx, 150, 520, session.startSizes.navWidth);
  } else if (session.kind === "inspector") {
    sizes.inspectorWidth = clampNumber(
      session.startSizes.inspectorWidth - dx,
      180,
      620,
      session.startSizes.inspectorWidth
    );
  } else if (session.kind === "panes") {
    const pair = resizeWeightPair(
      session.leftWidth,
      session.rightWidth,
      dx,
      220,
      session.startSizes.leftPaneWeight,
      session.startSizes.rightPaneWeight
    );
    sizes.leftPaneWeight = pair.primary;
    sizes.rightPaneWeight = pair.secondary;
  } else if (session.kind === "paneRows") {
    const pair = resizeWeightPair(
      session.topHeight,
      session.bottomHeight,
      dy,
      180,
      session.startSizes.topPaneWeight,
      session.startSizes.bottomPaneWeight
    );
    sizes.topPaneWeight = pair.primary;
    sizes.bottomPaneWeight = pair.secondary;
  } else if (session.kind === "dock") {
    sizes.dockHeight = clampNumber(session.startSizes.dockHeight - dy, 34, 280, session.startSizes.dockHeight);
  }
  applyLayoutResizeDraft(sizes);
  event.preventDefault();
}

async function saveLayoutSizeSettings(sizes) {
  if (!app.state) {
    return;
  }
  app.state.settings = {
    ...(app.state.settings || {}),
    layoutSizes: normalizeLayoutSizes(sizes)
  };
  await saveStateNow();
  applyAppSettingsChrome();
}

function finishLayoutResize(event) {
  const session = app.layoutResize;
  if (!session || (event.pointerId !== undefined && event.pointerId !== session.pointerId)) {
    return;
  }
  if (session.frame) {
    cancelAnimationFrame(session.frame);
  }
  const sizes = normalizeLayoutSizes(session.currentSizes);
  session.handle?.classList.remove("dragging");
  session.handle?.releasePointerCapture?.(session.pointerId);
  app.layoutResize = null;
  document.body.classList.remove("resizing-layout", "resizing-rows");
  applyLayoutSizeVariables(sizes);
  saveLayoutSizeSettings(sizes).catch((error) => showToast(error.message));
}

function applyAppSettingsChrome() {
  const settings = currentSettings();
  const shell = document.querySelector(".app-shell");
  if (!shell) {
    return;
  }
  for (const density of Object.keys(densityLabels)) {
    shell.classList.toggle(`density-${density}`, settings.density === density);
  }
  shell.classList.toggle("single-click-open", settings.openGesture === "single");
  shell.classList.toggle("navigator-off", !settings.navigator);
  shell.classList.toggle("inspector-off", !settings.inspector);
  shell.classList.toggle("focus-files", settings.focusMode);
  applyInspectorPresence();
  const focusButton = document.querySelector('[data-topbar-action="focus"]');
  focusButton?.classList.toggle("active", settings.focusMode);
  focusButton?.setAttribute("aria-pressed", String(settings.focusMode));
  document.querySelectorAll("[data-panel-action]").forEach((button) => {
    const panel = button.dataset.panelAction;
    const enabled = panel === "navigator" ? settings.navigator : settings.inspector;
    const label = panel === "navigator" ? "navigator" : "preview";
    button.classList.toggle("active", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    button.setAttribute("aria-label", `${enabled ? "Hide" : "Show"} ${label}`);
    button.title = settings.focusMode ? `Exit Focus to control ${label}` : `${enabled ? "Hide" : "Show"} ${label}`;
    button.disabled = settings.focusMode;
  });
  applyLayoutSizeVariables(settings.layoutSizes);
  applyToolbarVisibility();
}

function positionPaneMoreMenu(details) {
  const menu = details?.querySelector(".pane-more-menu");
  const summary = details?.querySelector(":scope > summary");
  menu?.classList.remove("positioned");
  if (!details?.open || !menu || !summary) {
    return;
  }
  requestAnimationFrame(() => {
    if (!details.open) return;
    const anchor = summary.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const margin = 8;
    const gap = 5;
    const left = Math.max(margin, Math.min(anchor.right - menuRect.width, window.innerWidth - menuRect.width - margin));
    const below = anchor.bottom + gap;
    const above = anchor.top - menuRect.height - gap;
    const top = below + menuRect.height <= window.innerHeight - margin ? below : Math.max(margin, above);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.classList.add("positioned");
  });
}

function toolbarVisibleActionSet(actions = currentSettings().toolbarActions) {
  const selected = normalizeToolbarActions(actions);
  const visible = new Set(selected.length ? selected : toolbarActionIds);
  for (const action of toolbarEssentialActions) {
    visible.add(action);
  }
  return visible;
}

function toolbarOrderList(order = currentSettings().toolbarOrder) {
  const saved = normalizeToolbarOrder(order);
  return [...saved, ...toolbarActionIds.filter((action) => !saved.includes(action))];
}

function toolbarOrderIndex(actionId, order = toolbarOrderList()) {
  const index = order.indexOf(actionId);
  return index === -1 ? toolbarActionIds.length : index;
}

function toolbarSelectionForSave() {
  return normalizeToolbarActions(
    [...document.querySelectorAll("[data-toolbar-action-choice]:checked")].map((input) => input.dataset.toolbarActionChoice)
  );
}

function toolbarPresetMatch(actions = currentSettings().toolbarActions) {
  const selected = toolbarVisibleActionSet(actions);
  for (const preset of toolbarPresetDefinitions) {
    const presetSet = toolbarVisibleActionSet(preset.actions);
    if (presetSet.size === selected.size && [...presetSet].every((action) => selected.has(action))) {
      return preset.id;
    }
  }
  return "custom";
}

function toolbarSummaryText(actions = currentSettings().toolbarActions) {
  const visible = toolbarVisibleActionSet(actions);
  if (visible.size === toolbarActionIds.length) {
    return "All buttons visible";
  }
  return `${visible.size} of ${toolbarActionIds.length} buttons visible`;
}

function applyToolbarVisibility() {
  const visible = toolbarVisibleActionSet();
  const order = toolbarOrderList();
  document.querySelectorAll(".command-dock [data-global-action]").forEach((button) => {
    const actionId = button.dataset.globalAction;
    button.hidden = !visible.has(actionId);
    button.draggable = true;
    button.style.order = String(toolbarOrderIndex(actionId, order));
  });
  const pasteMode = document.getElementById("paste-conflict-mode");
  if (pasteMode) {
    pasteMode.hidden = !visible.has("clipPaste");
    pasteMode.style.order = String(toolbarOrderIndex("clipPaste", order) + 0.2);
  }
  scheduleDockOverflowUpdate();
}

let dockOverflowFrame = 0;
let dockOverflowResizeObserver = null;

function dockOverflowCandidates(strip = document.querySelector(".dock-action-strip")) {
  if (!strip) return [];
  return [
    ...strip.querySelectorAll("#saved-command-strip > button, :scope > [data-global-action]")
  ]
    .filter((button) => !button.hidden)
    .sort((left, right) => {
      const orderDelta = Number.parseFloat(getComputedStyle(left).order || "0") - Number.parseFloat(getComputedStyle(right).order || "0");
      if (orderDelta) return orderDelta;
      return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
}

function dockActionCatalogItem(actionId) {
  return toolbarActionCatalog.find((item) => item.id === actionId) || null;
}

function dockOverflowItemMarkup(button) {
  const actionId = button.dataset.globalAction || "";
  const toolId = button.dataset.runTool || "";
  const scriptId = button.dataset.runScript || "";
  const catalogItem = actionId ? dockActionCatalogItem(actionId) : null;
  const label = String(catalogItem?.label || button.textContent || button.title || "Action").trim();
  const group = catalogItem?.group || (scriptId ? "Pinned script" : toolId ? "Pinned tool" : "Shelf");
  const title = String(button.title || label).trim();
  const actionAttribute = actionId
    ? `data-overflow-global-action="${escapeHtml(actionId)}"`
    : toolId
      ? `data-overflow-run-tool="${escapeHtml(toolId)}"`
      : `data-overflow-run-script="${escapeHtml(scriptId)}"`;
  return `<button type="button" role="menuitem" data-dock-overflow-item ${actionAttribute} title="${escapeHtml(title)}"><span>${escapeHtml(
    label
  )}</span><small>${escapeHtml(group)}</small></button>`;
}

function closeDockOverflowMenu(options = {}) {
  const toggle = document.getElementById("dock-overflow-toggle");
  const menu = document.getElementById("dock-overflow-menu");
  if (!toggle || !menu) return;
  menu.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  if (options.restoreFocus) toggle.focus();
}

function positionDockOverflowMenu() {
  const toggle = document.getElementById("dock-overflow-toggle");
  const menu = document.getElementById("dock-overflow-menu");
  if (!toggle || !menu || menu.hidden) return;
  const rect = toggle.getBoundingClientRect();
  const menuWidth = menu.getBoundingClientRect().width || 320;
  const left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.bottom = `${Math.max(8, Math.round(window.innerHeight - rect.top + 5))}px`;
}

function openDockOverflowMenu() {
  const toggle = document.getElementById("dock-overflow-toggle");
  const menu = document.getElementById("dock-overflow-menu");
  if (!toggle || !menu || toggle.hidden || !menu.children.length) return;
  menu.hidden = false;
  toggle.setAttribute("aria-expanded", "true");
  positionDockOverflowMenu();
  menu.querySelector("button")?.focus();
}

function updateDockOverflow() {
  dockOverflowFrame = 0;
  const strip = document.querySelector(".dock-action-strip");
  const toggle = document.getElementById("dock-overflow-toggle");
  const count = document.getElementById("dock-overflow-count");
  const menu = document.getElementById("dock-overflow-menu");
  if (!strip || !toggle || !count || !menu) return;
  closeDockOverflowMenu();
  const candidates = dockOverflowCandidates(strip);
  candidates.forEach((button) => button.classList.remove("dock-responsive-hidden"));
  toggle.hidden = true;
  menu.innerHTML = "";
  strip.scrollLeft = 0;
  strip.scrollTop = 0;
  const overflows = () => strip.scrollWidth > strip.clientWidth + 1 || strip.scrollHeight > strip.clientHeight + 1;
  if (!overflows()) return;
  toggle.hidden = false;
  const overflowed = [];
  for (let index = candidates.length - 1; index > 0 && overflows(); index -= 1) {
    const button = candidates[index];
    button.classList.add("dock-responsive-hidden");
    overflowed.unshift(button);
  }
  if (!overflowed.length) {
    toggle.hidden = true;
    return;
  }
  count.textContent = String(overflowed.length);
  toggle.title = `${overflowed.length} more shelf action${overflowed.length === 1 ? "" : "s"}`;
  toggle.setAttribute("aria-label", toggle.title);
  menu.innerHTML = overflowed.map(dockOverflowItemMarkup).join("");
}

function scheduleDockOverflowUpdate() {
  if (dockOverflowFrame) cancelAnimationFrame(dockOverflowFrame);
  dockOverflowFrame = requestAnimationFrame(updateDockOverflow);
}

function setupDockOverflow() {
  const strip = document.querySelector(".dock-action-strip");
  const dock = document.querySelector(".command-dock");
  const toggle = document.getElementById("dock-overflow-toggle");
  const menu = document.getElementById("dock-overflow-menu");
  if (!strip || !dock || !toggle || !menu) return;
  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (menu.hidden) openDockOverflowMenu();
    else closeDockOverflowMenu({ restoreFocus: true });
  });
  menu.addEventListener("click", async (event) => {
    const globalButton = event.target.closest("[data-overflow-global-action]");
    const toolButton = event.target.closest("[data-overflow-run-tool]");
    const scriptButton = event.target.closest("[data-overflow-run-script]");
    if (!globalButton && !toolButton && !scriptButton) {
      closeDockOverflowMenu();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeDockOverflowMenu();
    try {
      if (globalButton) {
        const actionId = globalButton.dataset.overflowGlobalAction;
        document.querySelector(`.command-dock [data-global-action="${CSS.escape(actionId)}"]`)?.click();
      }
      if (toolButton) await runTool(toolButton.dataset.overflowRunTool);
      if (scriptButton) await runSavedScript(scriptButton.dataset.overflowRunScript);
    } catch (error) {
      showToast(error.message);
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#dock-overflow-menu, #dock-overflow-toggle")) closeDockOverflowMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      closeDockOverflowMenu({ restoreFocus: true });
    }
  });
  window.addEventListener("resize", scheduleDockOverflowUpdate);
  dockOverflowResizeObserver?.disconnect();
  dockOverflowResizeObserver = new ResizeObserver(scheduleDockOverflowUpdate);
  dockOverflowResizeObserver.observe(strip);
  dockOverflowResizeObserver.observe(dock);
  scheduleDockOverflowUpdate();
}

function renderToolbarDialog() {
  const dialog = document.getElementById("toolbar-dialog");
  if (!dialog) {
    return;
  }
  const settings = currentSettings();
  const visible = toolbarVisibleActionSet(settings.toolbarActions);
  const match = toolbarPresetMatch(settings.toolbarActions);
  document.getElementById("toolbar-summary").textContent = `${toolbarSummaryText(
    settings.toolbarActions
  )} / drag dock buttons to reorder`;
  document.getElementById("toolbar-presets").innerHTML = toolbarPresetDefinitions
    .map(
      (preset) => `<button type="button" data-toolbar-preset="${escapeHtml(preset.id)}" class="${
        preset.id === match ? "active" : ""
      }">
        <strong>${escapeHtml(preset.name)}</strong>
        <small>${escapeHtml(preset.detail)}</small>
      </button>`
    )
    .join("");
  const groups = new Map();
  for (const action of toolbarActionCatalog) {
    if (!groups.has(action.group)) {
      groups.set(action.group, []);
    }
    groups.get(action.group).push(action);
  }
  document.getElementById("toolbar-action-list").innerHTML = [...groups]
    .map(([group, actions]) => {
      const choices = actions
        .map((action) => {
          const locked = toolbarEssentialActions.has(action.id);
          return `<label class="toolbar-action-choice${locked ? " locked" : ""}">
            <input type="checkbox" data-toolbar-action-choice="${escapeHtml(action.id)}" ${
              visible.has(action.id) ? "checked" : ""
            } ${locked ? "disabled" : ""} />
            <span>${escapeHtml(action.label)}${locked ? " (fixed)" : ""}</span>
          </label>`;
        })
        .join("");
      return `<section class="toolbar-action-group">
        <strong>${escapeHtml(group)}</strong>
        ${choices}
      </section>`;
    })
    .join("");
}

async function saveToolbarFromDialog() {
  const selected = toolbarSelectionForSave();
  for (const action of toolbarEssentialActions) {
    if (!selected.includes(action)) {
      selected.unshift(action);
    }
  }
  await saveSettingsPatch({ toolbarActions: normalizeToolbarActions(selected) }, { message: "Toolbar saved" });
}

async function applyToolbarPreset(presetId) {
  const preset = toolbarPresetDefinitions.find((item) => item.id === presetId) || toolbarPresetDefinitions[0];
  await saveSettingsPatch({ toolbarActions: normalizeToolbarActions(preset.actions) }, { message: `${preset.name} toolbar` });
}

async function showAllToolbarActions() {
  await saveSettingsPatch({ toolbarActions: [] }, { message: "All toolbar buttons visible" });
}

async function openToolbarDialog() {
  await loadState();
  applyToolbarVisibility();
  renderToolbarDialog();
  document.getElementById("toolbar-dialog").showModal();
}

function renderPreferencesDialog() {
  const dialog = document.getElementById("preferences-dialog");
  if (!dialog) {
    return;
  }
  const settings = currentSettings();
  document.getElementById("preference-density").value = settings.density;
  document.getElementById("preference-open-gesture").value = settings.openGesture;
  document.getElementById("preference-startup-mode").value = settings.startupMode;
  renderStartupLayoutPicker(settings);
  document.getElementById("preference-paste-conflict").value = settings.pasteConflictMode;
  document.getElementById("preference-navigator").checked = settings.navigator;
  document.getElementById("preference-inspector").checked = settings.inspector;
  document.getElementById("preference-inspector-auto-collapse").checked = settings.inspectorAutoCollapse;
  document.getElementById("preference-auto-refresh").checked = settings.autoRefresh;
  document.getElementById("preference-show-hidden").checked = settings.showHidden;
  document.getElementById("preference-linked-navigation").checked = settings.linkedNavigation;
  document.getElementById("preference-confirm-trash").checked = settings.confirmTrash;
  document.getElementById("preference-launch-mode").value = settings.launchMode;
  document.getElementById("preference-shell-open-mode").value = settings.shellOpenMode;
  renderPreferencesSummary(settings);
}

function renderStartupLayoutPicker(settings = currentSettings()) {
  const row = document.getElementById("preference-startup-layout-row");
  const select = document.getElementById("preference-startup-layout");
  if (!row || !select) {
    return;
  }
  const layouts = app.state?.layouts || [];
  const selectedId = layouts.some((layout) => layout.id === settings.startupLayoutId)
    ? settings.startupLayoutId
    : layouts[0]?.id || "";
  select.innerHTML = layouts.length
    ? layouts
        .map(
          (layout) =>
            `<option value="${escapeHtml(layout.id)}">${escapeHtml(layout.name)} (${escapeHtml(
              layoutPaneText(layout.layout, "left")
            )} / ${escapeHtml(layoutPaneText(layout.layout, "right"))})</option>`
        )
        .join("")
    : `<option value="">No saved layouts</option>`;
  select.value = selectedId;
  select.disabled = !layouts.length;
  row.hidden = normalizeStartupMode(settings.startupMode) !== "savedLayout";
}

function preferenceSettingsDraftFromForm() {
  const startupMode = normalizeStartupMode(document.getElementById("preference-startup-mode").value);
  const startupLayoutId = normalizeReferenceId(document.getElementById("preference-startup-layout").value);
  return {
    ...currentSettings(),
    density: normalizeDensity(document.getElementById("preference-density").value),
    openGesture: normalizeOpenGesture(document.getElementById("preference-open-gesture").value),
    startupMode: startupMode === "savedLayout" && !startupLayoutId ? "last" : startupMode,
    startupLayoutId
  };
}

function renderPreferencesSummary(settings = currentSettings()) {
  document.getElementById("preferences-summary").textContent = `${densityLabels[settings.density]} / ${
    openGestureLabels[settings.openGesture]
  }`;
  const generated = app.state?.integration?.generatedAt;
  const regenText = generated
    ? "Changing launch or shell-open defaults regenerates the Explorer integration files."
    : "Generate integration files after choosing replacement defaults.";
  document.getElementById("preferences-readout").textContent = `${
    startupSettingLabel(settings)
  } on normal launch. ${launchModeLabels[settings.launchMode]} / ${
    shellOpenModeLabels[settings.shellOpenMode]
  }. ${openGestureLabels[settings.openGesture]}. ${regenText}`;
}

function preferencesSettingsFromForm() {
  const startupMode = normalizeStartupMode(document.getElementById("preference-startup-mode").value);
  const startupLayoutId = normalizeReferenceId(document.getElementById("preference-startup-layout").value);
  return normalizedKnownSettings({
    density: document.getElementById("preference-density").value,
    openGesture: document.getElementById("preference-open-gesture").value,
    startupMode: startupMode === "savedLayout" && !startupLayoutId ? "last" : startupMode,
    startupLayoutId,
    pasteConflictMode: document.getElementById("preference-paste-conflict").value,
    focusMode: currentSettings().focusMode,
    navigator: document.getElementById("preference-navigator").checked,
    inspector: document.getElementById("preference-inspector").checked,
    inspectorAutoCollapse: document.getElementById("preference-inspector-auto-collapse").checked,
    autoRefresh: document.getElementById("preference-auto-refresh").checked,
    showHidden: document.getElementById("preference-show-hidden").checked,
    linkedNavigation: document.getElementById("preference-linked-navigation").checked,
    confirmTrash: document.getElementById("preference-confirm-trash").checked,
    launchMode: document.getElementById("preference-launch-mode").value,
    shellOpenMode: document.getElementById("preference-shell-open-mode").value,
    layoutSizes: currentSettings().layoutSizes,
    toolbarActions: currentSettings().toolbarActions,
    toolbarOrder: currentSettings().toolbarOrder
  });
}

function defaultPreferenceSettings() {
  return normalizedKnownSettings({
    density: "comfortable",
    openGesture: "double",
    startupMode: "last",
    startupLayoutId: "",
    focusMode: false,
    navigator: true,
    inspector: true,
    inspectorAutoCollapse: true,
    confirmTrash: true,
    launchMode: "appWindow",
    shellOpenMode: "leftReplace",
    pasteConflictMode: "unique",
    autoRefresh: true,
    showHidden: true,
    linkedNavigation: false,
    layoutSizes: normalizeLayoutSizes(),
    toolbarActions: [],
    toolbarOrder: []
  });
}

async function refreshHiddenSensitiveChrome() {
  app.folderTree.nodes.clear();
  app.folderTree.loading.clear();
  app.folderTree.leafPaths.clear();
  const paneNames = watchablePaneNames();
  await Promise.all(
    paneNames.map((paneName) =>
      refreshPane(paneName, { preserveSelection: true, save: false, silent: true })
    )
  );
  renderAll();
}

async function saveSettingsPatch(patch, options = {}) {
  if (!app.state) {
    await loadState();
  }
  const previous = currentSettings();
  app.state.settings = {
    ...(app.state.settings || {}),
    ...patch
  };
  await saveStateNow();
  const next = currentSettings();
  applyAppSettingsChrome();
  renderPasteConflictMode();
  renderAutoRefreshToggle();
  renderShowHiddenToggle();
  renderLinkedNavigationToggle();
  renderToolbarDialog();
  renderPreferencesDialog();
  renderBackupDialog();
  renderIntegration();
  if (previous.autoRefresh !== next.autoRefresh) {
    scheduleAutoRefresh(next.autoRefresh ? 250 : null);
  }
  if (previous.showHidden !== next.showHidden || options.refreshHidden) {
    await refreshHiddenSensitiveChrome();
  }
  if (
    options.regenerateIntegration &&
    (previous.launchMode !== next.launchMode || previous.shellOpenMode !== next.shellOpenMode) &&
    app.state.integration?.generatedAt
  ) {
    const result = await request("/api/integration/generate", { method: "POST" });
    const output = document.getElementById("integration-output");
    if (output) {
      output.textContent = JSON.stringify(result, null, 2);
    }
    await loadIntegrationStatus();
    renderIntegration();
    renderPreferencesDialog();
  }
  if (options.message) {
    showToast(options.message);
  }
}

async function toggleFocusMode(force = null) {
  const enabled = typeof force === "boolean" ? force : !currentSettings().focusMode;
  await saveSettingsPatch(
    { focusMode: enabled },
    { message: enabled ? "Focus workspace on" : "Focus workspace off" }
  );
}

async function toggleWorkspacePanel(panel, force = null) {
  const key = panel === "navigator" ? "navigator" : panel === "preview" ? "inspector" : null;
  if (!key || currentSettings().focusMode) {
    return;
  }
  const enabled = typeof force === "boolean" ? force : !currentSettings()[key];
  const label = key === "navigator" ? "Navigator" : "Preview";
  await saveSettingsPatch({ [key]: enabled }, { message: `${label} ${enabled ? "shown" : "hidden"}` });
  if (key === "inspector" && enabled) {
    renderInspector();
  }
}

async function applyPreferencesFromForm() {
  await saveSettingsPatch(preferencesSettingsFromForm(), {
    regenerateIntegration: true,
    message: "Preferences saved"
  });
}

async function resetPreferencesToDefaults() {
  await saveSettingsPatch(defaultPreferenceSettings(), {
    regenerateIntegration: true,
    refreshHidden: true,
    message: "Preferences reset"
  });
}

async function openPreferencesDialog() {
  await loadState();
  applyAppSettingsChrome();
  renderPreferencesDialog();
  document.getElementById("preferences-dialog").showModal();
}

function currentPasteConflictMode() {
  return currentSettings().pasteConflictMode;
}

function renderPasteConflictMode() {
  const select = document.getElementById("paste-conflict-mode");
  if (select) {
    select.value = currentPasteConflictMode();
  }
}

async function updatePasteConflictMode(value) {
  await saveSettingsPatch(
    { pasteConflictMode: normalizeConflictMode(value) },
    { message: `Paste policy: ${conflictModeLabels[normalizeConflictMode(value)]}` }
  );
}

function autoRefreshEnabled() {
  return currentSettings().autoRefresh;
}

function renderAutoRefreshToggle() {
  const toggle = document.getElementById("auto-refresh-toggle");
  if (!toggle) {
    return;
  }
  const enabled = autoRefreshEnabled();
  toggle.checked = enabled;
  toggle.closest(".dock-toggle")?.classList.toggle("active", enabled);
}

async function updateAutoRefreshSetting(enabled) {
  await saveSettingsPatch({ autoRefresh: Boolean(enabled) }, { message: enabled ? "Auto refresh on" : "Auto refresh off" });
}

function showHiddenEntriesEnabled() {
  return currentSettings().showHidden;
}

function renderShowHiddenToggle() {
  const toggle = document.getElementById("show-hidden-toggle");
  if (!toggle) {
    return;
  }
  const enabled = showHiddenEntriesEnabled();
  toggle.checked = enabled;
  toggle.closest(".dock-toggle")?.classList.toggle("active", enabled);
}

async function updateShowHiddenSetting(enabled) {
  await saveSettingsPatch({ showHidden: Boolean(enabled) });
  const message = enabled ? "Hidden items shown" : "Hidden items hidden";
  setStatus(message);
  showToast(message);
}

function linkedNavigationEnabled() {
  return currentSettings().linkedNavigation;
}

function renderLinkedNavigationToggle() {
  const toggle = document.getElementById("linked-navigation-toggle");
  if (!toggle) {
    return;
  }
  const enabled = linkedNavigationEnabled();
  toggle.checked = enabled;
  toggle.closest(".dock-toggle")?.classList.toggle("active", enabled);
}

async function updateLinkedNavigationSetting(enabled) {
  await saveSettingsPatch(
    { linkedNavigation: Boolean(enabled) },
    { message: enabled ? "Linked panes on" : "Linked panes off" }
  );
}

async function maybeFollowLinkedPane(paneName, previousPath, nextPath, options = {}) {
  if (options.linkedFollow || !isPaneName(paneName) || !linkedNavigationEnabled()) {
    return;
  }
  if (isZipVirtualPath(previousPath) || isZipVirtualPath(nextPath) || tabOf(otherPane(paneName))?.virtualMode) {
    return;
  }
  const targetPane = otherPane(paneName);
  const targetPath = linkedNavigationTarget(previousPath, nextPath, tabOf(targetPane).path);
  if (!targetPath || samePath(targetPath, tabOf(targetPane).path)) {
    return;
  }
  try {
    await loadPane(targetPane, targetPath, true, {
      linkedFollow: true,
      silent: true,
      preserveSelection: false,
      save: options.save
    });
  } catch (error) {
    if (!options.silent) {
      setStatus("Linked pane target unavailable");
    }
  }
}

function previewViewerButton(preview) {
  return `<button data-preview-action="viewer" data-preview-path="${escapeHtml(preview.path)}">Viewer</button>`;
}

function previewActionBar(preview, extraMarkup = "") {
  return `<div class="preview-actions">${previewViewerButton(preview)}${extraMarkup}</div>`;
}

async function renderInspector() {
  const inspector = document.getElementById("inspector");
  const body = inspector.querySelector(".inspector-body");
  const renderToken = ++app.inspectorRenderToken;
  app.inspectorPreviewController?.abort();
  app.inspectorPreviewController = null;
  applyInspectorPresence();
  if (!inspectorEnabled()) {
    body.innerHTML = `<div class="muted">Preview disabled</div>`;
    return;
  }
  const selection = selectedPaths(app.activePane);
  if (!selection.length) {
    body.innerHTML = `<div class="muted">Select an item</div>`;
    return;
  }
  if (selection.length > 1) {
    const labeledCount = selection.filter((itemPath) => pathLabelFor(itemPath)).length;
    body.innerHTML = `<h3 class="preview-name">${selection.length} items</h3><div class="preview-meta"><span>Batch operations ready</span><span>${labeledCount} labeled</span></div>`;
    return;
  }

  try {
    body.innerHTML = `<div class="preview-loading" role="status" aria-label="Loading preview"><span></span><span></span><span></span></div>`;
    const controller = new AbortController();
    app.inspectorPreviewController = controller;
    const label = pathLabelFor(selection[0]);
    const labelPanel = label
      ? `<div class="preview-label">${labelBadgeMarkup(label)}${
          label.notes ? `<span>${escapeHtml(label.notes)}</span>` : ""
        }</div>`
      : "";
    const preview = await request(`/api/preview?path=${encodeURIComponent(selection[0])}`, { signal: controller.signal });
    if (renderToken !== app.inspectorRenderToken || selectedPaths(app.activePane)[0] !== selection[0]) {
      return;
    }
    const meta = `
      <div class="preview-meta">
        <span>${escapeHtml(preview.path)}</span>
        ${preview.size !== undefined ? `<span>${formatSize(preview.size)}</span>` : ""}
        ${preview.modified ? `<span>${formatDate(preview.modified)}</span>` : ""}
      </div>`;

    if (preview.type === "image") {
      body.innerHTML = `<h3 class="preview-name">${escapeHtml(
        preview.name
      )}</h3>${meta}${labelPanel}${previewActionBar(
        preview
      )}<img class="preview-image" src="${escapeHtml(preview.url)}" alt="">`;
      return;
    }
    if (preview.type === "text") {
      body.innerHTML = `<h3 class="preview-name">${escapeHtml(
        preview.name
      )}</h3>${meta}${labelPanel}${previewActionBar(
        preview,
        `<button data-preview-action="edit-text" data-preview-path="${escapeHtml(preview.path)}">Edit</button>`
      )}<pre class="preview-text">${escapeHtml(preview.content)}</pre>`;
      return;
    }
    if (preview.type === "pdf") {
      body.innerHTML = `<h3 class="preview-name">${escapeHtml(
        preview.name
      )}</h3>${meta}${labelPanel}${previewActionBar(preview)}<iframe class="preview-frame" src="${escapeHtml(
        preview.url
      )}" title="${escapeHtml(preview.name)}"></iframe>`;
      return;
    }
    if (preview.type === "audio") {
      body.innerHTML = `<h3 class="preview-name">${escapeHtml(
        preview.name
      )}</h3>${meta}${labelPanel}${previewActionBar(
        preview
      )}<div class="preview-media-shell"><audio class="preview-audio" controls preload="metadata"><source src="${escapeHtml(
        preview.url
      )}" type="${escapeHtml(preview.mime || "")}"></audio></div>`;
      return;
    }
    if (preview.type === "video") {
      body.innerHTML = `<h3 class="preview-name">${escapeHtml(
        preview.name
      )}</h3>${meta}${labelPanel}${previewActionBar(
        preview
      )}<video class="preview-media" controls preload="metadata"><source src="${escapeHtml(
        preview.url
      )}" type="${escapeHtml(preview.mime || "")}"></video>`;
      return;
    }
    if (preview.type === "folder") {
      body.innerHTML = `<h3 class="preview-name">${escapeHtml(
        preview.name
      )}</h3><div class="preview-meta"><span>${escapeHtml(
        preview.path
      )}</span><span>${preview.count} items</span></div>${labelPanel}`;
      return;
    }
    body.innerHTML = `<h3 class="preview-name">${escapeHtml(
      preview.name
    )}</h3>${meta}${labelPanel}<div class="muted">${preview.type}</div>`;
  } catch (error) {
    if (isAbortError(error) || renderToken !== app.inspectorRenderToken) {
      return;
    }
    body.innerHTML = `<div class="muted">${escapeHtml(error.message)}</div>`;
  } finally {
    if (renderToken === app.inspectorRenderToken) {
      app.inspectorPreviewController = null;
    }
  }
}

function isViewerPreview(preview) {
  return viewerPreviewTypes.has(preview?.type);
}

function viewerSupportsEntry(entry) {
  if (!entry?.isFile || entry.unavailable || isZipVirtualEntry(entry)) {
    return false;
  }
  const extension = String(entry.extension || "").toLowerCase();
  return viewerPreviewKinds.has(entry.kind) || extension === ".pdf";
}

function viewerCandidates(paneName) {
  return visibleEntries(paneName).filter(viewerSupportsEntry);
}

function viewerInitialPath(paneName, itemPath = null) {
  if (itemPath) {
    return itemPath;
  }
  const tab = tabOf(paneName);
  const focused = entryForPath(paneName, tab.focusedPath);
  if (focused) {
    return focused.path;
  }
  const selected = selectedEntries(paneName)[0];
  if (selected) {
    return selected.path;
  }
  return viewerCandidates(paneName)[0]?.path || null;
}

function viewerMetaText(preview) {
  const pieces = [];
  const count = app.viewer.entries.length;
  if (count && app.viewer.index >= 0) {
    pieces.push(`${app.viewer.index + 1} of ${count}`);
  }
  if (preview?.path) {
    pieces.push(preview.path);
  }
  if (preview?.size !== undefined) {
    pieces.push(formatSize(preview.size));
  }
  if (preview?.modified) {
    pieces.push(formatDate(preview.modified));
  }
  return pieces.filter(Boolean).join(" | ") || "No file loaded";
}

function viewerBodyMarkup(preview) {
  if (preview?.type === "image") {
    return `<img class="viewer-image" src="${escapeHtml(preview.url)}" alt="">`;
  }
  if (preview?.type === "text") {
    return `<pre class="viewer-text">${escapeHtml(preview.content)}</pre>`;
  }
  if (preview?.type === "pdf") {
    return `<iframe class="viewer-frame" src="${escapeHtml(preview.url)}" title="${escapeHtml(
      preview.name
    )}"></iframe>`;
  }
  if (preview?.type === "audio") {
    return `<div class="viewer-audio-shell"><audio class="viewer-audio" controls preload="metadata"><source src="${escapeHtml(
      preview.url
    )}" type="${escapeHtml(preview.mime || "")}"></audio></div>`;
  }
  if (preview?.type === "video") {
    return `<video class="viewer-media" controls preload="metadata"><source src="${escapeHtml(
      preview.url
    )}" type="${escapeHtml(preview.mime || "")}"></video>`;
  }
  const name = preview?.name || labelForPath(preview?.path);
  const type = preview?.type ? `Type: ${preview.type}` : "No preview available";
  return `<div class="viewer-empty"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(type)}</span></div>`;
}

function viewerStripEntry(entryPath) {
  return entryForPath(app.viewer.paneName, entryPath) || {
    path: entryPath,
    name: labelForPath(entryPath),
    kind: "File",
    isFile: true
  };
}

function viewerStripThumbMarkup(entry, glyph) {
  if (!entry.unavailable && entry.kind === "Image" && entry.isFile) {
    return `<img class="viewer-strip-thumb-image" src="${escapeHtml(rawFileUrl(entry))}" loading="lazy" alt="">`;
  }
  return `<span class="viewer-strip-glyph ${escapeHtml(glyph.className)}">${escapeHtml(glyph.text)}</span>`;
}

function renderViewerStrip() {
  const strip = document.getElementById("viewer-strip");
  if (!strip) {
    return;
  }
  const entries = app.viewer.entries || [];
  if (!entries.length) {
    strip.innerHTML = `<div class="viewer-strip-empty">No previewable neighbors</div>`;
    return;
  }
  const activeIndex = entries.findIndex((entryPath) => samePath(entryPath, app.viewer.path));
  const visibleLimit = 120;
  const startIndex =
    entries.length > visibleLimit && activeIndex >= 0
      ? Math.max(0, Math.min(activeIndex - Math.floor(visibleLimit / 2), entries.length - visibleLimit))
      : 0;
  const visibleEntriesForStrip = entries.slice(startIndex, startIndex + visibleLimit);
  const leadingOverflow = startIndex;
  const trailingOverflow = Math.max(0, entries.length - startIndex - visibleEntriesForStrip.length);
  strip.innerHTML = `
    <div class="viewer-strip-count">${activeIndex >= 0 ? activeIndex + 1 : 0}/${entries.length}</div>
    <div class="viewer-strip-scroll" role="listbox" aria-label="Previewable files">
      ${leadingOverflow ? `<div class="viewer-strip-overflow">+${leadingOverflow}</div>` : ""}
      ${visibleEntriesForStrip
        .map((entryPath) => {
          const entry = viewerStripEntry(entryPath);
          const glyph = glyphFor(entry);
          const active = samePath(entryPath, app.viewer.path);
          const detail = [entry.kind, imageDimensionsText(entry), entrySizeText(entry), formatDate(entry.modified)]
            .filter(Boolean)
            .join(" / ");
          return `<button type="button" class="viewer-strip-item ${active ? "active" : ""}" data-viewer-path="${escapeHtml(
            entryPath
          )}" title="${escapeHtml([entry.name, detail, entry.path].filter(Boolean).join("\n"))}" role="option" aria-selected="${
            active ? "true" : "false"
          }">
            <span class="viewer-strip-thumb">${viewerStripThumbMarkup(entry, glyph)}</span>
            <span class="viewer-strip-name">${escapeHtml(entry.name || labelForPath(entryPath))}</span>
          </button>`;
        })
        .join("")}
      ${trailingOverflow ? `<div class="viewer-strip-overflow">+${trailingOverflow}</div>` : ""}
    </div>
  `;
  requestAnimationFrame(() => {
    strip.querySelector(".viewer-strip-item.active")?.scrollIntoView({ block: "nearest", inline: "center" });
  });
}

function renderViewerNav() {
  const count = app.viewer.entries.length;
  document.querySelectorAll('[data-viewer-action="previous"], [data-viewer-action="next"]').forEach((button) => {
    button.disabled = count < 2;
  });
  const revealButton = document.querySelector('[data-viewer-action="reveal"]');
  if (revealButton) {
    revealButton.disabled = !app.viewer.path;
  }
}

function renderViewer(preview) {
  document.getElementById("viewer-title").textContent = preview?.name || labelForPath(preview?.path) || "Viewer";
  document.getElementById("viewer-meta").textContent = viewerMetaText(preview);
  document.getElementById("viewer-body").innerHTML = viewerBodyMarkup(preview);
  renderViewerStrip();
  renderViewerNav();
}

function syncViewerIndex() {
  app.viewer.index = app.viewer.entries.findIndex((entryPath) => samePath(entryPath, app.viewer.path));
}

function selectViewerPathInPane(paneName, itemPath) {
  const entry = entryForPath(paneName, itemPath);
  if (!entry) {
    return;
  }
  const tab = tabOf(paneName);
  tab.selected = new Set([entry.path]);
  tab.focusedPath = entry.path;
  tab.anchorPath = entry.path;
  commitSelectionChange(paneName, { focusList: false });
}

async function loadViewerPath(itemPath) {
  if (!itemPath) {
    return;
  }
  app.viewer.path = itemPath;
  syncViewerIndex();
  renderViewer({ name: labelForPath(itemPath), path: itemPath, type: "loading" });
  try {
    const preview = await request(`/api/preview?path=${encodeURIComponent(itemPath)}`);
    app.viewer.path = preview.path || itemPath;
    app.viewer.preview = preview;
    syncViewerIndex();
    renderViewer(preview);
    selectViewerPathInPane(app.viewer.paneName, app.viewer.path);
    if (!isViewerPreview(preview)) {
      showToast("Viewer supports text, images, PDF, audio, and video");
    }
  } catch (error) {
    app.viewer.preview = null;
    renderViewer({ name: labelForPath(itemPath), path: itemPath, type: error.message });
    showToast(error.message);
  }
}

async function openViewer(paneName = app.activePane, itemPath = null) {
  if (!isPaneName(paneName)) {
    paneName = app.activePane;
  }
  const targetPath = viewerInitialPath(paneName, itemPath);
  if (!targetPath) {
    return showToast("Select a previewable file first");
  }
  const targetEntry = entryForPath(paneName, targetPath);
  if (targetEntry && !viewerSupportsEntry(targetEntry)) {
    return showToast("Viewer supports text, images, PDF, audio, and video");
  }
  const entries = viewerCandidates(paneName).map((entry) => entry.path);
  if (targetEntry && viewerSupportsEntry(targetEntry) && !entries.some((entryPath) => samePath(entryPath, targetPath))) {
    entries.push(targetPath);
  }
  app.viewer = {
    paneName,
    path: targetPath,
    entries,
    index: entries.findIndex((entryPath) => samePath(entryPath, targetPath)),
    preview: null
  };
  const dialog = document.getElementById("viewer-dialog");
  if (!dialog.open) {
    dialog.showModal();
  }
  await loadViewerPath(targetPath);
}

async function stepViewer(delta) {
  const entries = app.viewer.entries || [];
  if (entries.length < 2) {
    return showToast("No previewable neighbor files");
  }
  const currentIndex = entries.findIndex((entryPath) => samePath(entryPath, app.viewer.path));
  const baseIndex = currentIndex >= 0 ? currentIndex : delta > 0 ? -1 : 0;
  const nextIndex = (baseIndex + delta + entries.length) % entries.length;
  await loadViewerPath(entries[nextIndex]);
}

async function revealViewerPath() {
  if (!app.viewer.path) {
    return;
  }
  await request("/api/open", {
    method: "POST",
    body: JSON.stringify({ path: app.viewer.path, reveal: true })
  });
}

async function handleViewerKey(event) {
  const dialog = document.getElementById("viewer-dialog");
  if (!dialog?.open || event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) {
    return false;
  }
  if (event.key === "ArrowLeft" || event.key === "PageUp") {
    event.preventDefault();
    await stepViewer(-1);
    return true;
  }
  if (event.key === "ArrowRight" || event.key === "PageDown") {
    event.preventDefault();
    await stepViewer(1);
    return true;
  }
  if (event.key === "Home" && app.viewer.entries?.length) {
    event.preventDefault();
    await loadViewerPath(app.viewer.entries[0]);
    return true;
  }
  if (event.key === "End" && app.viewer.entries?.length) {
    event.preventDefault();
    await loadViewerPath(app.viewer.entries.at(-1));
    return true;
  }
  return false;
}

function selectedEntry(paneName = app.activePane) {
  const selection = selectedPaths(paneName);
  if (selection.length !== 1) {
    return null;
  }
  return tabOf(paneName).entries.find((entry) => samePath(entry.path, selection[0])) || null;
}

function textEditorContent() {
  return document.getElementById("text-editor-content").value;
}

function updateTextEditorSummary(message = "") {
  const summary = document.getElementById("text-editor-summary");
  if (!summary) {
    return;
  }
  const editor = app.textEditor;
  if (!editor) {
    summary.textContent = message || "No file loaded";
    return;
  }
  const dirty = textEditorContent() !== editor.originalContent;
  const bytes = new Blob([textEditorContent()]).size;
  summary.textContent =
    message ||
    [
      dirty ? "modified" : "clean",
      formatSize(bytes),
      editor.modified ? `loaded ${formatDate(editor.modified)}` : ""
    ]
      .filter(Boolean)
      .join(" / ");
}

async function openTextEditor(paneName = app.activePane, itemPath = null) {
  const targetPath = itemPath || selectedPaths(paneName)[0];
  if (!targetPath) {
    return showToast("Select a text file first");
  }
  if (isZipVirtualPath(targetPath)) {
    return showToast("Extract the ZIP to edit files inside it");
  }
  const preview = await request(`/api/preview?path=${encodeURIComponent(targetPath)}`);
  if (preview.type !== "text") {
    return showToast("Select a small text file");
  }
  app.textEditor = {
    paneName,
    path: preview.path,
    originalContent: preview.content,
    modified: preview.modified,
    size: preview.size
  };
  document.getElementById("text-editor-path").value = preview.path;
  document.getElementById("text-editor-content").value = preview.content;
  document.getElementById("text-editor-title").textContent = preview.name;
  updateTextEditorSummary();
  document.getElementById("text-editor-dialog").showModal();
  document.getElementById("text-editor-content").focus();
}

async function reloadTextEditor() {
  if (!app.textEditor?.path) {
    return showToast("No text file loaded");
  }
  await openTextEditor(app.textEditor.paneName || app.activePane, app.textEditor.path);
}

async function saveTextEditor(force = false) {
  if (!app.textEditor?.path) {
    return showToast("No text file loaded");
  }
  updateTextEditorSummary("Saving...");
  const result = await request("/api/text/save", {
    method: "POST",
    body: JSON.stringify({
      path: app.textEditor.path,
      content: textEditorContent(),
      expectedModified: app.textEditor.modified,
      force
    })
  });
  app.textEditor.originalContent = textEditorContent();
  app.textEditor.modified = result.modified;
  app.textEditor.size = result.bytes;
  await refreshPane(app.textEditor.paneName || app.activePane);
  await syncStateAndChrome();
  renderInspector();
  updateTextEditorSummary("Saved");
  showToast("Text saved");
}

function selectEntry(paneName, entryPath, event = {}) {
  app.activePane = paneName;
  const tab = tabOf(paneName);
  const entries = visibleEntries(paneName);
  tab.focusedPath = entryPath;

  if (event.shiftKey) {
    const anchorPath = usableAnchorPath(tab, entries, entryPath);
    tab.anchorPath = anchorPath;
    tab.selected = new Set(rangePaths(entries, anchorPath, entryPath));
  } else if (event.ctrlKey || event.metaKey) {
    if (tab.selected.has(entryPath)) {
      tab.selected.delete(entryPath);
    } else {
      tab.selected.add(entryPath);
    }
    tab.anchorPath = entryPath;
  } else {
    tab.selected = new Set([entryPath]);
    tab.anchorPath = entryPath;
  }
  commitSelectionChange(paneName);
}

function entryOpenRecently(paneName, entryPath) {
  const last = app.lastEntryOpen;
  return Boolean(
    last &&
    last.paneName === paneName &&
    samePath(last.path, entryPath) &&
    Date.now() - last.at < 600
  );
}

function singleClickOpenEnabled() {
  return currentSettings().openGesture === "single";
}

async function openEntryInOtherPane(paneName, entryPath) {
  const entry = entryForPath(paneName, entryPath);
  if (!entry) {
    return false;
  }
  const targetPane = otherPane(paneName);
  if (isRealZipFileEntry(entry)) {
    await loadPane(targetPane, zipVirtualPathFor(entry.path, ""));
  } else if (entry.isDirectory) {
    await loadPane(targetPane, entry.path);
  } else {
    return false;
  }
  focusPaneList(targetPane);
  showToast(`Opened ${entry.name} in ${targetPane}`);
  return true;
}

async function openEntryFromGesture(paneName, entryPath, options = {}) {
  if (entryOpenRecently(paneName, entryPath)) {
    return false;
  }
  app.lastEntryOpen = { paneName, path: entryPath, at: Date.now() };
  if (options.otherPane) {
    return openEntryInOtherPane(paneName, entryPath);
  }
  await openEntry(paneName, entryPath);
  return true;
}

async function openEntry(paneName, entryPath) {
  const entry = entryForPath(paneName, entryPath);
  if (!entry) {
    return false;
  }
  if (entry.isDirectory) {
    await loadPane(paneName, entry.path);
    return true;
  }
  if (isRealZipFileEntry(entry)) {
    await loadPane(paneName, zipVirtualPathFor(entry.path, ""));
    return true;
  }
  if (isZipVirtualEntry(entry)) {
    showToast("Extract the ZIP to open files inside it");
    return false;
  }
  await request("/api/open", {
    method: "POST",
    body: JSON.stringify({ path: entry.path, reveal: false })
  });
  return true;
}

async function goBack(paneName) {
  const tab = tabOf(paneName);
  const previous = tab.history.at(-1);
  if (!previous) {
    return;
  }
  if (shouldBranchLockedNavigation(paneName, previous)) {
    await openLockedNavigationBranch(paneName, previous, {}, {
      history: tab.history.slice(0, -1),
      future: [tab.path, ...tab.future],
      linkedPreviousPath: tab.path
    });
    return;
  }
  tab.history.pop();
  tab.future.push(tab.path);
  await loadPane(paneName, previous, false);
}

async function goForward(paneName) {
  const tab = tabOf(paneName);
  const next = tab.future.at(-1);
  if (!next) {
    return;
  }
  if (shouldBranchLockedNavigation(paneName, next)) {
    await openLockedNavigationBranch(paneName, next, {}, {
      history: [...tab.history, tab.path],
      future: tab.future.slice(0, -1),
      linkedPreviousPath: tab.path
    });
    return;
  }
  tab.future.pop();
  tab.history.push(tab.path);
  await loadPane(paneName, next, false);
}

function paneHistoryGroupMarkup(title, rows) {
  if (!rows.length) {
    return "";
  }
  return `<section class="history-group">
    <div class="history-group-title">${escapeHtml(title)}</div>
    ${rows.join("")}
  </section>`;
}

function paneHistoryTargetMarkup(item) {
  return `<button type="button" class="history-row" data-history-pane="${escapeHtml(
    item.paneName
  )}" data-history-kind="${escapeHtml(item.kind)}" data-history-index="${escapeHtml(item.index)}" title="${escapeHtml(
    item.path
  )}">
    <span>${escapeHtml(item.badge)}</span>
    <strong>${escapeHtml(labelForPath(item.path))}</strong>
    <code>${escapeHtml(item.path)}</code>
  </button>`;
}

function paneHistoryCurrentMarkup(paneName, itemPath) {
  if (!itemPath) {
    return `<div class="history-row current empty">
      <span>Now</span>
      <strong>No active path</strong>
      <code>Open a folder to begin pane history.</code>
    </div>`;
  }
  return `<div class="history-row current" aria-current="location" title="${escapeHtml(itemPath)}">
    <span>Now</span>
    <strong>${escapeHtml(labelForPath(itemPath))}</strong>
    <code>${escapeHtml(itemPath)}</code>
  </div>`;
}

function renderPaneHistoryDialog() {
  const paneName = isPaneName(app.historyDialog?.paneName) ? app.historyDialog.paneName : app.activePane;
  const tab = tabOf(paneName);
  const history = Array.isArray(tab.history) ? tab.history : [];
  const future = Array.isArray(tab.future) ? tab.future : [];
  const summary = document.getElementById("history-summary");
  if (summary) {
    summary.textContent = `${paneName === "left" ? "Left" : "Right"} pane / ${history.length} back / ${
      future.length
    } forward`;
  }
  document.querySelectorAll("[data-history-switch]").forEach((button) => {
    button.classList.toggle("active", button.dataset.historySwitch === paneName);
  });
  const backRows = history
    .map((itemPath, index) => ({
      paneName,
      kind: "history",
      index,
      path: itemPath,
      badge: `Back ${history.length - index}`
    }))
    .reverse()
    .map(paneHistoryTargetMarkup);
  const forwardRows = future
    .map((itemPath, index) => ({
      paneName,
      kind: "future",
      index,
      path: itemPath,
      badge: `Next ${future.length - index}`
    }))
    .reverse()
    .map(paneHistoryTargetMarkup);
  const list = document.getElementById("history-list");
  if (!list) {
    return;
  }
  const content = [
    paneHistoryGroupMarkup("Back stack", backRows),
    paneHistoryGroupMarkup("Current", [paneHistoryCurrentMarkup(paneName, tab.path)]),
    paneHistoryGroupMarkup("Forward stack", forwardRows)
  ]
    .filter(Boolean)
    .join("");
  list.innerHTML =
    content ||
    `<div class="empty-state">No pane history yet. Open a few folders and they will appear here.</div>`;
}

function openPaneHistoryDialog(paneName = app.activePane) {
  const targetPane = isPaneName(paneName) ? paneName : app.activePane;
  app.activePane = targetPane;
  app.historyDialog.paneName = targetPane;
  updateActivePaneChrome();
  renderPaneHistoryDialog();
  const dialog = document.getElementById("history-dialog");
  if (!dialog.open) {
    dialog.showModal();
  }
}

function paneHistoryJumpState(tab, kind, rawIndex) {
  const index = Number(rawIndex);
  if (!Number.isInteger(index)) {
    return null;
  }
  const history = Array.isArray(tab.history) ? tab.history : [];
  const future = Array.isArray(tab.future) ? tab.future : [];
  const currentPath = tab.path || "";
  if (kind === "history" && index >= 0 && index < history.length) {
    const skippedHistory = history.slice(index + 1).reverse();
    return {
      targetPath: history[index],
      history: history.slice(0, index),
      future: [...future, ...(currentPath ? [currentPath] : []), ...skippedHistory]
    };
  }
  if (kind === "future" && index >= 0 && index < future.length) {
    const skippedFuture = future.slice(index + 1).reverse();
    return {
      targetPath: future[index],
      history: [...history, ...(currentPath ? [currentPath] : []), ...skippedFuture],
      future: future.slice(0, index)
    };
  }
  return null;
}

async function jumpToPaneHistory(paneName, kind, rawIndex) {
  if (!isPaneName(paneName)) {
    return;
  }
  const tab = tabOf(paneName);
  const jump = paneHistoryJumpState(tab, kind, rawIndex);
  if (!jump?.targetPath) {
    showToast("History target is unavailable");
    return;
  }
  const currentPath = tab.path;
  if (shouldBranchLockedNavigation(paneName, jump.targetPath)) {
    await openLockedNavigationBranch(paneName, jump.targetPath, {}, {
      history: jump.history,
      future: jump.future,
      linkedPreviousPath: currentPath
    });
  } else {
    const oldHistory = Array.isArray(tab.history) ? [...tab.history] : [];
    const oldFuture = Array.isArray(tab.future) ? [...tab.future] : [];
    tab.history = jump.history;
    tab.future = jump.future;
    try {
      await loadPane(paneName, jump.targetPath, false);
    } catch (error) {
      tab.history = oldHistory;
      tab.future = oldFuture;
      renderPane(paneName);
      throw error;
    }
  }
  showToast(`Opened ${labelForPath(jump.targetPath)} from pane history`);
}

async function goUp(paneName) {
  const tab = tabOf(paneName);
  if (tab.parent && tab.parent !== tab.path) {
    await loadPane(paneName, tab.parent);
  }
}

async function newFolder(paneName) {
  const name = prompt("Folder name");
  if (!name) {
    return;
  }
  await request("/api/mkdir", {
    method: "POST",
    body: JSON.stringify({ path: tabOf(paneName).path, name })
  });
  await refreshPane(paneName);
  await syncStateAndChrome();
  showToast("Folder created");
}

async function createShortcutsForSelection(paneName, targetDir = tabOf(paneName).path) {
  const paths = selectedPaths(paneName);
  if (!paths.length) {
    return showToast("Select items first");
  }
  const result = await request("/api/shortcut/create", {
    method: "POST",
    body: JSON.stringify({ paths, targetDir, conflictMode: "unique" })
  });
  await refreshPane(paneName);
  await syncStateAndChrome();
  const count = result.created?.length || paths.length;
  showToast(`Created ${count} shortcut${count === 1 ? "" : "s"}`);
  setStatus(`Shortcut${count === 1 ? "" : "s"} created in ${labelForPath(targetDir)}`);
  return result;
}

function openLinkDialog(paneName = app.activePane) {
  const paths = selectedPaths(paneName);
  if (!paths.length) {
    return showToast("Select items first");
  }
  app.link = { paneName, paths, targetDir: tabOf(paneName).path };
  document.getElementById("link-selection").textContent = `${paths.length} selected`;
  document.getElementById("link-target").value = app.link.targetDir;
  document.getElementById("link-kind").value = "auto";
  document.getElementById("link-conflict").value = "unique";
  document.getElementById("link-summary").textContent = "Ready";
  document.getElementById("link-dialog").showModal();
}

async function createLinksFromForm() {
  const paths = app.link?.paths || [];
  if (!paths.length) {
    return showToast("Select items first");
  }
  const targetDir = document.getElementById("link-target").value;
  const result = await request("/api/link/create", {
    method: "POST",
    body: JSON.stringify({
      paths,
      targetDir,
      linkKind: document.getElementById("link-kind").value,
      conflictMode: document.getElementById("link-conflict").value
    })
  });
  await Promise.all([refreshPane(app.link.paneName), refreshPane(otherPane(app.link.paneName))]);
  await syncStateAndChrome();
  const count = result.count || result.created?.length || paths.length;
  const message = `Created ${count} link${count === 1 ? "" : "s"}`;
  document.getElementById("link-summary").textContent = message;
  document.getElementById("link-dialog").close();
  setStatus(`${message} in ${labelForPath(targetDir)}`);
  showToast(message);
  return result;
}

function newFileTemplateContent(template, name) {
  const title = pathStem(name || "New File");
  if (template === "text") {
    return "";
  }
  if (template === "markdown") {
    return `# ${title}\n\n`;
  }
  if (template === "json") {
    return "{\n  \n}\n";
  }
  if (template === "javascript") {
    return "console.log(\"Hello from Explore Better\");\n";
  }
  if (template === "powershell") {
    return "Write-Output \"Hello from Explore Better\"\n";
  }
  return "";
}

function updateNewFileTemplate(force = false) {
  const content = document.getElementById("new-file-content");
  const template = document.getElementById("new-file-template").value;
  if (force || !content.value.trim()) {
    content.value = newFileTemplateContent(template, document.getElementById("new-file-name").value);
  }
}

function defaultNewFileName(template = "empty") {
  if (template === "markdown") return "notes.md";
  if (template === "json") return "data.json";
  if (template === "javascript") return "script.js";
  if (template === "powershell") return "script.ps1";
  return "New File.txt";
}

function openNewFileDialog(paneName = app.activePane) {
  const folder = tabOf(paneName).path;
  app.activePane = paneName;
  app.newFile = { paneName, folder };
  document.getElementById("new-file-folder").value = folder;
  document.getElementById("new-file-template").value = "empty";
  document.getElementById("new-file-name").value = defaultNewFileName();
  document.getElementById("new-file-conflict").value = "unique";
  document.getElementById("new-file-edit").checked = true;
  document.getElementById("new-file-content").value = "";
  document.getElementById("new-file-summary").textContent = "Ready";
  document.getElementById("new-file-dialog").showModal();
  document.getElementById("new-file-name").focus();
  document.getElementById("new-file-name").select();
}

async function createNewFileFromForm() {
  const paneName = app.newFile?.paneName || app.activePane;
  const body = {
    path: document.getElementById("new-file-folder").value,
    name: document.getElementById("new-file-name").value.trim(),
    content: document.getElementById("new-file-content").value,
    conflictMode: document.getElementById("new-file-conflict").value
  };
  if (!body.name) {
    return showToast("File name is required");
  }
  document.getElementById("new-file-summary").textContent = "Creating...";
  const result = await request("/api/file/create", {
    method: "POST",
    body: JSON.stringify(body)
  });
  document.getElementById("new-file-summary").textContent = labelForPath(result.path);
  await refreshPane(paneName);
  await syncStateAndChrome();
  if (document.getElementById("new-file-edit").checked) {
    document.getElementById("new-file-dialog").close();
    await openTextEditor(paneName, result.path);
  }
  showToast(`Created ${labelForPath(result.path)}`);
  return result;
}

function inlineRenameTarget(paneName, itemPath = null) {
  if (itemPath) {
    return entryForPath(paneName, itemPath);
  }
  const entries = selectedEntries(paneName);
  if (entries[0]) {
    return entries[0];
  }
  const focusedPath = tabOf(paneName).focusedPath;
  return focusedPath ? entryForPath(paneName, focusedPath) : null;
}

function focusInlineRenameInput(selectName = true) {
  requestAnimationFrame(() => {
    const input = document.querySelector("[data-inline-rename]");
    if (!input) {
      return;
    }
    input.focus({ preventScroll: true });
    if (!selectName) {
      return;
    }
    const value = input.value;
    const dotAt = app.inlineRename?.isFile ? value.lastIndexOf(".") : -1;
    const end = dotAt > 0 ? dotAt : value.length;
    input.setSelectionRange(0, end);
  });
}

function cancelInlineRename(options = {}) {
  const paneName = app.inlineRename?.paneName;
  app.inlineRename = null;
  if (paneName) {
    renderPane(paneName);
  }
  if (options.focusList !== false && paneName) {
    focusPaneList(paneName);
  }
  if (options.status) {
    setStatus(options.status);
  }
}

function beginInlineRename(paneName, itemPath = null) {
  const entry = inlineRenameTarget(paneName, itemPath);
  if (!entry) {
    return showToast("Select an item first");
  }
  if (entry.unavailable) {
    return showToast("Unavailable items cannot be renamed");
  }
  const tab = tabOf(paneName);
  app.activePane = paneName;
  tab.selected = new Set([entry.path]);
  tab.focusedPath = entry.path;
  tab.anchorPath = entry.path;
  app.inlineRename = {
    paneName,
    path: entry.path,
    originalName: entry.name,
    value: entry.name,
    isFile: entry.isFile,
    committing: false
  };
  renderPane(paneName);
  renderInspector();
  updateSelectionReadout();
  setStatus(`${paneName}: rename ${entry.name}`);
  focusInlineRenameInput();
}

function selectPathInPane(paneName, itemPath) {
  const entry = entryForPath(paneName, itemPath);
  if (!entry) {
    return false;
  }
  const tab = tabOf(paneName);
  tab.selected = new Set([entry.path]);
  tab.focusedPath = entry.path;
  tab.anchorPath = entry.path;
  return true;
}

function renameResultPath(result, rename, nextName) {
  const candidates = [
    result?.path,
    result?.operation?.result?.path,
    result?.operation?.result?.result?.path,
    result?.operation?.result?.renamed?.[0],
    result?.operation?.result?.result?.renamed?.[0]
  ];
  return candidates.find(Boolean) || siblingPathForName(rename.path, nextName);
}

function selectRenamedEntryInPane(paneName, renamedPath, nextName, sourcePath) {
  if (selectPathInPane(paneName, renamedPath)) {
    return true;
  }
  const sourceParent = parentPathOf(sourcePath);
  const entry = tabOf(paneName).entries.find(
    (item) => item.name === nextName && samePath(parentPathOf(item.path), sourceParent)
  );
  if (!entry) {
    return false;
  }
  return selectPathInPane(paneName, entry.path);
}

async function commitInlineRename(input = null) {
  const rename = app.inlineRename;
  if (!rename || rename.committing) {
    return;
  }
  const paneName = rename.paneName;
  const nextName = String(input?.value ?? rename.value ?? "").trim();
  if (!nextName) {
    showToast("Name is required");
    focusInlineRenameInput(false);
    return;
  }
  if (nextName === rename.originalName) {
    cancelInlineRename({ status: "Rename unchanged" });
    return;
  }
  app.inlineRename = { ...rename, value: nextName, committing: true };
  setStatus(`Renaming ${rename.originalName}`);
  try {
    const result = await request("/api/rename", {
      method: "POST",
      body: JSON.stringify({ path: rename.path, name: nextName })
    });
    app.inlineRename = null;
    await refreshPane(paneName);
    const renamedPath = renameResultPath(result, rename, nextName);
    await syncStateAndChrome();
    if (selectRenamedEntryInPane(paneName, renamedPath, nextName, rename.path)) {
      renderPane(paneName);
      scrollFocusedEntryIntoView(paneName);
    }
    updateSelectionReadout();
    renderInspector();
    showToast(`Renamed to ${labelForPath(renamedPath)}`);
  } catch (error) {
    app.inlineRename = { ...rename, value: nextName, committing: false };
    renderPane(paneName);
    focusInlineRenameInput(false);
    showToast(error.message);
    setStatus("Rename failed");
  }
}

async function renameSelected(paneName) {
  beginInlineRename(paneName);
}

function openBulkRenameDialog(paneName) {
  const paths = selectedPaths(paneName);
  if (!paths.length) {
    return showToast("Select items first");
  }
  app.bulkRename = { paneName, paths, plan: null };
  applyBulkRenameOptionsToForm({});
  document.getElementById("bulk-summary").textContent = `${paths.length} selected`;
  document.getElementById("bulk-results").innerHTML = "";
  document.getElementById("bulk-apply").disabled = true;
  renderBulkRenamePresets();
  document.getElementById("bulk-dialog").showModal();
  runBulkRenamePreview().catch((error) => {
    document.getElementById("bulk-summary").textContent = error.message;
  });
}

function bulkRenameOptionsFromForm() {
  return {
    find: document.getElementById("bulk-find").value,
    replace: document.getElementById("bulk-replace").value,
    prefix: document.getElementById("bulk-prefix").value,
    suffix: document.getElementById("bulk-suffix").value,
    caseMode: document.getElementById("bulk-case").value,
    numberPosition: document.getElementById("bulk-number-position").value,
    numberStart: Number(document.getElementById("bulk-number-start").value || 1),
    numberPad: Number(document.getElementById("bulk-number-pad").value || 2),
    numberSeparator: document.getElementById("bulk-number-separator").value,
    preserveExtension: document.getElementById("bulk-preserve-extension").checked,
    useRegex: document.getElementById("bulk-regex").checked,
    matchCase: document.getElementById("bulk-match-case").checked
  };
}

function bulkRenamePayload() {
  return {
    paths: app.bulkRename?.paths || [],
    options: bulkRenameOptionsFromForm()
  };
}

function normalizeBulkRenamePresetOptions(options = {}) {
  const source = options && typeof options === "object" ? options : {};
  const allowedCaseModes = new Set(["keep", "lower", "upper", "title"]);
  const allowedNumberPositions = new Set(["none", "prefix", "suffix"]);
  return {
    find: String(source.find || "").slice(0, 500),
    replace: String(source.replace || "").slice(0, 500),
    prefix: String(source.prefix || "").slice(0, 200),
    suffix: String(source.suffix || "").slice(0, 200),
    caseMode: allowedCaseModes.has(source.caseMode) ? source.caseMode : "keep",
    numberPosition: allowedNumberPositions.has(source.numberPosition) ? source.numberPosition : "none",
    numberStart: Number.isFinite(Number(source.numberStart)) ? Number(source.numberStart) : 1,
    numberPad: Math.max(1, Math.min(Number(source.numberPad || 2), 12)),
    numberSeparator: String(source.numberSeparator ?? "-").slice(0, 20),
    preserveExtension: source.preserveExtension !== false,
    useRegex: source.useRegex === true,
    matchCase: source.matchCase === true
  };
}

function bulkRenamePresetLabel(options = {}) {
  const normalized = normalizeBulkRenamePresetOptions(options);
  const parts = [];
  if (normalized.find) {
    parts.push(`${normalized.useRegex ? "regex" : "find"}:${normalized.find}`);
  }
  if (normalized.replace) {
    parts.push(`replace:${normalized.replace}`);
  }
  if (normalized.prefix) {
    parts.push(`prefix:${normalized.prefix}`);
  }
  if (normalized.suffix) {
    parts.push(`suffix:${normalized.suffix}`);
  }
  if (normalized.caseMode !== "keep") {
    parts.push(normalized.caseMode);
  }
  if (normalized.numberPosition !== "none") {
    parts.push(`${normalized.numberPosition} #${normalized.numberStart}`);
  }
  if (!normalized.preserveExtension) {
    parts.push("rename ext");
  }
  if (normalized.matchCase) {
    parts.push("case-sensitive");
  }
  return parts.join(" / ") || "No rename rules";
}

function bulkRenamePresets() {
  if (!app.state) {
    return [];
  }
  if (!Array.isArray(app.state.bulkRenamePresets)) {
    app.state.bulkRenamePresets = [];
  }
  return app.state.bulkRenamePresets;
}

function currentBulkRenamePreset() {
  const presets = bulkRenamePresets();
  return presets.find((preset) => preset.id === app.activeBulkRenamePresetId) || presets[0] || null;
}

function defaultBulkRenamePresetName(options = bulkRenameOptionsFromForm()) {
  const label = bulkRenamePresetLabel(options);
  return label === "No rename rules" ? "Rename Preset" : label.slice(0, 80);
}

function applyBulkRenameOptionsToForm(options = {}) {
  const normalized = normalizeBulkRenamePresetOptions(options);
  document.getElementById("bulk-find").value = normalized.find;
  document.getElementById("bulk-replace").value = normalized.replace;
  document.getElementById("bulk-prefix").value = normalized.prefix;
  document.getElementById("bulk-suffix").value = normalized.suffix;
  document.getElementById("bulk-case").value = normalized.caseMode;
  document.getElementById("bulk-number-position").value = normalized.numberPosition;
  document.getElementById("bulk-number-start").value = normalized.numberStart;
  document.getElementById("bulk-number-pad").value = normalized.numberPad;
  document.getElementById("bulk-number-separator").value = normalized.numberSeparator;
  document.getElementById("bulk-preserve-extension").checked = normalized.preserveExtension;
  document.getElementById("bulk-regex").checked = normalized.useRegex;
  document.getElementById("bulk-match-case").checked = normalized.matchCase;
}

function bulkRenamePresetDetail(preset) {
  return preset?.options ? bulkRenamePresetLabel(preset.options) : "";
}

function renderBulkRenamePresets() {
  const select = document.getElementById("bulk-preset-select");
  if (!select) {
    return;
  }
  const presets = bulkRenamePresets();
  if (
    (!app.activeBulkRenamePresetId || !presets.some((preset) => preset.id === app.activeBulkRenamePresetId)) &&
    presets[0]
  ) {
    app.activeBulkRenamePresetId = presets[0].id;
  }
  const active = currentBulkRenamePreset();
  select.innerHTML = presets.length
    ? presets
        .map(
          (preset) =>
            `<option value="${escapeHtml(preset.id)}" ${preset.id === active?.id ? "selected" : ""}>${escapeHtml(
              preset.name
            )}</option>`
        )
        .join("")
    : `<option value="">No saved rename presets</option>`;
  document.getElementById("bulk-preset-name").value = active?.name || "";
  document.getElementById("bulk-preset-summary").textContent = active
    ? bulkRenamePresetDetail(active)
    : `${presets.length} presets`;
}

async function saveBulkRenamePresetFromForm(replaceActive = false) {
  if (!app.state) {
    await loadState();
  }
  const options = normalizeBulkRenamePresetOptions(bulkRenameOptionsFromForm());
  const existing = replaceActive ? currentBulkRenamePreset() : null;
  if (replaceActive && !existing) {
    showToast("Select a rename preset first");
    return null;
  }
  const name =
    document.getElementById("bulk-preset-name").value.trim() ||
    existing?.name ||
    defaultBulkRenamePresetName(options);
  const saved = {
    ...existing,
    id: existing?.id || crypto.randomUUID(),
    name,
    updatedAt: new Date().toISOString(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    options
  };
  app.state.bulkRenamePresets = [
    saved,
    ...bulkRenamePresets().filter((preset) => preset.id !== saved.id)
  ].slice(0, 50);
  app.activeBulkRenamePresetId = saved.id;
  await saveStateNow();
  renderBulkRenamePresets();
  renderBackupDialog();
  showToast(replaceActive ? "Rename preset replaced" : "Rename preset saved");
  return saved;
}

async function applyActiveBulkRenamePreset() {
  const preset = currentBulkRenamePreset();
  if (!preset) {
    return showToast("Save a rename preset first");
  }
  applyBulkRenameOptionsToForm(preset.options);
  document.getElementById("bulk-preset-name").value = preset.name;
  document.getElementById("bulk-summary").textContent = `Preset: ${preset.name}`;
  await runBulkRenamePreview();
  showToast(`Applied ${preset.name}`);
}

async function deleteActiveBulkRenamePreset() {
  const preset = currentBulkRenamePreset();
  if (!preset) {
    return showToast("Select a rename preset first");
  }
  if (!confirm(`Delete rename preset "${preset.name}"?`)) {
    return;
  }
  app.state.bulkRenamePresets = bulkRenamePresets().filter((item) => item.id !== preset.id);
  app.activeBulkRenamePresetId = app.state.bulkRenamePresets[0]?.id || null;
  await saveStateNow();
  renderBulkRenamePresets();
  renderBackupDialog();
  showToast("Rename preset deleted");
}

function bulkCountsText(counts = {}) {
  const parts = ["ready", "unchanged", "collision", "duplicate", "invalid", "missing"]
    .map((key) => (counts[key] ? `${key}: ${counts[key]}` : ""))
    .filter(Boolean);
  return parts.length ? parts.join(" / ") : "no changes";
}

function renderBulkRenamePlan(plan) {
  app.bulkRename.plan = plan;
  const total = plan.items.length;
  document.getElementById("bulk-summary").textContent = `${total} item(s) / ${bulkCountsText(
    plan.counts
  )}`;
  document.getElementById("bulk-apply").disabled = !plan.canApply;
  const results = document.getElementById("bulk-results");
  results.innerHTML = plan.items.length
    ? plan.items
        .map(
          (item) =>
            `<div class="bulk-row ${escapeHtml(item.status)}">
              <span class="bulk-index">${item.index + 1}</span>
              <span>
                <strong title="${escapeHtml(item.source)}">${escapeHtml(item.originalName)}</strong>
                <small>${escapeHtml(item.parent)}</small>
              </span>
              <span>
                <strong title="${escapeHtml(item.dest)}">${escapeHtml(item.newName)}</strong>
                <small>${escapeHtml(item.reason || item.status)}</small>
              </span>
              <span><span class="bulk-status ${escapeHtml(item.status)}">${escapeHtml(
                item.status
              )}</span></span>
            </div>`
        )
        .join("")
    : `<div class="empty-state">No selected items</div>`;
}

async function runBulkRenamePreview() {
  if (!app.bulkRename?.paths?.length) {
    return showToast("Select items first");
  }
  document.getElementById("bulk-summary").textContent = "Previewing...";
  document.getElementById("bulk-apply").disabled = true;
  const plan = await request("/api/bulk-rename/preview", {
    method: "POST",
    body: JSON.stringify(bulkRenamePayload())
  });
  renderBulkRenamePlan(plan);
}

async function applyBulkRename() {
  if (!app.bulkRename?.paths?.length) {
    return showToast("Select items first");
  }
  await runBulkRenamePreview();
  if (!app.bulkRename.plan?.canApply) {
    return showToast("Bulk rename preview has conflicts");
  }
  const result = await request("/api/bulk-rename", {
    method: "POST",
    body: JSON.stringify(bulkRenamePayload())
  });
  await refreshPane(app.bulkRename.paneName);
  await syncStateAndChrome();
  document.getElementById("bulk-dialog").close();
  showToast(`Renamed ${result.renamed.length} item(s)`);
}

async function operationPreview(type, payload) {
  return request("/api/operation/preview", {
    method: "POST",
    body: JSON.stringify({ ...payload, type })
  });
}

function shouldOpenTransferPreflight(plan) {
  const items = Array.isArray(plan?.items) ? plan.items : [];
  return (
    items.length > 1 ||
    items.some((item) => item.isDirectory || item.existing || item.status !== "ready" || item.action === "overwrite")
  );
}

function openTransferPreflight(paneName, paths, options = {}) {
  openTransferDialogWithPaths(paneName, paths, {
    targetDir: options.targetDir,
    mode: options.mode,
    conflictMode: options.conflictMode || "unique",
    plan: options.plan
  });
  showToast(`${options.mode === "move" ? "Move" : "Copy"} preview ready`);
}

async function copyToOther(paneName) {
  const paths = selectedPaths(paneName);
  if (!paths.length) {
    return showToast("Select items first");
  }
  const targetDir = tabOf(otherPane(paneName)).path;
  const preview = await operationPreview("copy", { paths, targetDir, conflictMode: "unique" });
  if (shouldOpenTransferPreflight(preview)) {
    return openTransferPreflight(paneName, paths, {
      targetDir,
      mode: "copy",
      conflictMode: "unique",
      plan: preview
    });
  }
  await request("/api/copy", {
    method: "POST",
    body: JSON.stringify({ paths, targetDir })
  });
  await refreshPane(otherPane(paneName));
  await syncStateAndChrome();
  showToast("Copied");
}

async function moveToOther(paneName) {
  const paths = selectedPaths(paneName);
  if (!paths.length) {
    return showToast("Select items first");
  }
  const targetDir = tabOf(otherPane(paneName)).path;
  const preview = await operationPreview("move", { paths, targetDir, conflictMode: "unique" });
  if (shouldOpenTransferPreflight(preview)) {
    return openTransferPreflight(paneName, paths, {
      targetDir,
      mode: "move",
      conflictMode: "unique",
      plan: preview
    });
  }
  await request("/api/move", {
    method: "POST",
    body: JSON.stringify({ paths, targetDir })
  });
  await refreshPane(paneName);
  await refreshPane(otherPane(paneName));
  await syncStateAndChrome();
  showToast("Moved");
}

function openTransferDialogWithPaths(paneName, paths, options = {}) {
  app.transfer = { paneName, paths, plan: null, itemPolicies: {} };
  document.getElementById("transfer-target").value = options.targetDir || tabOf(otherPane(paneName)).path;
  document.getElementById("transfer-mode").value = options.mode || "copy";
  document.getElementById("transfer-conflict").value = normalizeConflictMode(options.conflictMode);
  document.getElementById("transfer-summary").textContent = `${paths.length} selected`;
  document.getElementById("transfer-results").innerHTML = "";
  document.getElementById("transfer-apply").disabled = true;
  document.getElementById("transfer-dialog").showModal();
  if (options.plan) {
    renderTransferPlan(options.plan);
    return;
  }
  runTransferPreview().catch((error) => {
    document.getElementById("transfer-summary").textContent = error.message;
  });
}

function openTransferDialog(paneName) {
  const paths = selectedPaths(paneName);
  if (!paths.length) {
    return showToast("Select items first");
  }
  openTransferDialogWithPaths(paneName, paths, {
    targetDir: tabOf(otherPane(paneName)).path,
    mode: "copy",
    conflictMode: "unique"
  });
}

function transferPayload(options = {}) {
  const payload = {
    paths: app.transfer?.paths || [],
    targetDir: document.getElementById("transfer-target").value,
    mode: document.getElementById("transfer-mode").value,
    conflictMode: document.getElementById("transfer-conflict").value,
    itemPolicies: app.transfer?.itemPolicies || {}
  };
  if (options.expectedPlanDigest) {
    payload.expectedPlanDigest = options.expectedPlanDigest;
  }
  if (options.applyToken) {
    payload.applyToken = options.applyToken;
  }
  return payload;
}

function transferCountsText(counts = {}, actionCounts = {}) {
  const actionParts = ["copy", "move", "rename", "overwrite", "skip", "unchanged", "risky"]
    .map((key) => (actionCounts[key] ? `${key}: ${actionCounts[key]}` : ""))
    .filter(Boolean);
  if (actionParts.length) {
    return actionParts.join(" / ");
  }
  const parts = ["ready", "skip", "unchanged", "invalid", "missing", "duplicate"]
    .map((key) => (counts[key] ? `${key}: ${counts[key]}` : ""))
    .filter(Boolean);
  return parts.length ? parts.join(" / ") : "no changes";
}

function transferPolicyControl(item, plan) {
  if (!item.existing || ["invalid", "missing", "duplicate", "unchanged"].includes(item.status)) {
    return `<span class="transfer-policy muted">-</span>`;
  }
  const override = app.transfer?.itemPolicies?.[item.source] || "";
  const selected = (value) => (override === value ? "selected" : "");
  return `<label class="transfer-policy">
    <span class="sr-only">Policy for ${escapeHtml(item.originalName)}</span>
    <select data-transfer-policy="${escapeHtml(item.source)}" aria-label="Policy for ${escapeHtml(item.originalName)}">
      <option value="" ${selected("")}>Default ${escapeHtml(plan.conflictMode)}</option>
      <option value="unique" ${selected("unique")}>Rename</option>
      <option value="overwrite" ${selected("overwrite")}>Overwrite</option>
      <option value="skip" ${selected("skip")}>Skip</option>
    </select>
  </label>`;
}

function renderTransferPlan(plan) {
  app.transfer.plan = plan;
  document.getElementById("transfer-summary").textContent = `${plan.items.length} item(s) / ${plan.mode} / ${
    plan.conflictMode
  } / ${transferCountsText(plan.counts, plan.actionCounts)}`;
  document.getElementById("transfer-apply").disabled = !plan.canApply;
  const results = document.getElementById("transfer-results");
  results.innerHTML = plan.items.length
    ? plan.items
        .map(
          (item) =>
            `<div class="transfer-row ${escapeHtml(item.status)}">
              <span class="transfer-index">${item.index + 1}</span>
              <span>
                <strong title="${escapeHtml(item.source)}">${escapeHtml(item.originalName)}</strong>
                <small>${escapeHtml(item.source)}</small>
              </span>
              <span>
                <strong title="${escapeHtml(item.dest)}">${escapeHtml(labelForPath(item.dest))}</strong>
                <small>${escapeHtml(item.dest)}</small>
              </span>
              <span><span class="transfer-status ${escapeHtml(item.status)}">${escapeHtml(
                item.status
              )}</span></span>
              <span>${transferPolicyControl(item, plan)}</span>
              <span>${escapeHtml(item.reason || "")}</span>
            </div>`
        )
        .join("")
    : `<div class="empty-state">No selected items</div>`;
}

async function runTransferPreview() {
  if (!app.transfer?.paths?.length) {
    return showToast("Select items first");
  }
  document.getElementById("transfer-summary").textContent = "Previewing...";
  document.getElementById("transfer-apply").disabled = true;
  const plan = await request("/api/transfer/preview", {
    method: "POST",
    body: JSON.stringify(transferPayload())
  });
  renderTransferPlan(plan);
}

async function applyTransfer() {
  if (!app.transfer?.paths?.length) {
    return showToast("Select items first");
  }
  await runTransferPreview();
  if (!app.transfer.plan?.canApply) {
    return showToast("Transfer preview has conflicts");
  }
  const result = await request("/api/transfer", {
    method: "POST",
    body: JSON.stringify(transferPayload({
      expectedPlanDigest: app.transfer.plan.planDigest,
      applyToken: app.transfer.plan.applyToken
    }))
  });
  await Promise.all([refreshPane("left"), refreshPane("right")]);
  await syncStateAndChrome();
  document.getElementById("transfer-dialog").close();
  showToast(`${result.mode === "move" ? "Moved" : "Copied"} ${result.transferred.length} item(s)`);
}

function destinationKindLabel(kind) {
  const labels = {
    other: "OTHER",
    current: "HERE",
    parent: "UP",
    favorite: "FAV",
    alias: "AL",
    recent: "REC",
    shortcut: "ROOT",
    drive: "DRV"
  };
  return labels[kind] || "DIR";
}

function destinationTargetClass(target, activePath) {
  return [
    "destination-target",
    samePath(target.path, activePath) ? "active" : "",
    target.kind === "favorite" ? "destination-favorite" : "",
    target.kind === "favorite" ? favoriteColorClass(target.color) : "",
    target.kind === "drive" ? "destination-drive" : "",
    driveSpaceLevel(target) ? `drive-${driveSpaceLevel(target)}` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function addDestinationTarget(targets, seen, target) {
  if (!target?.path) {
    return;
  }
  const key = normalizedPathKey(target.path);
  if (!key || seen.has(key)) {
    return;
  }
  seen.add(key);
  targets.push(target);
}

function destinationTargets(paneName = app.activePane) {
  const targets = [];
  const seen = new Set();
  const activeTab = tabOf(paneName);
  const otherTab = tabOf(otherPane(paneName));
  const parentPath = parentPathOf(activeTab.path);

  addDestinationTarget(targets, seen, {
    kind: "other",
    name: `${otherPane(paneName).toUpperCase()} pane`,
    path: otherTab.path,
    detail: "Other pane"
  });
  addDestinationTarget(targets, seen, {
    kind: "current",
    name: `${paneName.toUpperCase()} pane`,
    path: activeTab.path,
    detail: "Active folder"
  });
  if (parentPath && !samePath(parentPath, activeTab.path)) {
    addDestinationTarget(targets, seen, {
      kind: "parent",
      name: labelForPath(parentPath),
      path: parentPath,
      detail: "Parent folder"
    });
  }
  for (const favorite of favorites()) {
    addDestinationTarget(targets, seen, {
      ...favorite,
      kind: "favorite",
      name: favorite.name || labelForPath(favorite.path),
      detail: "Favorite"
    });
  }
  for (const alias of pathAliases()) {
    addDestinationTarget(targets, seen, {
      ...alias,
      kind: "alias",
      name: `${alias.name}:`,
      detail: alias.description || "Alias"
    });
  }
  for (const recent of app.state?.recentLocations || []) {
    addDestinationTarget(targets, seen, {
      ...recent,
      kind: "recent",
      name: recent.name || labelForPath(recent.path),
      detail: recent.visitedAt ? formatDate(recent.visitedAt) : "Recent"
    });
  }
  for (const shortcut of app.roots?.shortcuts || []) {
    addDestinationTarget(targets, seen, {
      ...shortcut,
      kind: "shortcut",
      detail: "Shortcut"
    });
  }
  for (const drive of app.roots?.drives || []) {
    addDestinationTarget(targets, seen, {
      ...drive,
      kind: "drive",
      detail: driveSpaceText(drive) || "Drive"
    });
  }
  return targets;
}

function destinationTargetPath() {
  return document.getElementById("destination-target")?.value.trim() || "";
}

function destinationTransferPayload() {
  return {
    paths: app.destination?.paths || [],
    targetDir: destinationTargetPath(),
    mode: document.getElementById("destination-mode")?.value === "move" ? "move" : "copy",
    conflictMode: normalizeConflictMode(document.getElementById("destination-conflict")?.value),
    itemPolicies: {}
  };
}

function destinationSelectionItems() {
  const paneName = app.destination?.paneName || app.activePane;
  const entries = new Map(tabOf(paneName).entries.map((entry) => [normalizedPathKey(entry.path), entry]));
  return (app.destination?.paths || []).map((itemPath) => {
    const entry = entries.get(normalizedPathKey(itemPath));
    return {
      path: itemPath,
      name: entry?.name || labelForPath(itemPath),
      kind: entry?.kind || (entry?.isDirectory ? "Folder" : "Item"),
      isDirectory: Boolean(entry?.isDirectory)
    };
  });
}

function renderDestinationDialog(message = "") {
  const dialog = document.getElementById("destination-dialog");
  if (!dialog || !app.destination) {
    return;
  }
  const targetPath = destinationTargetPath();
  const payload = destinationTransferPayload();
  const targets = destinationTargets(app.destination.paneName);
  app.destination.targets = targets;
  document.getElementById("destination-heading").textContent = `${app.destination.paths.length} selected`;
  document.getElementById("destination-summary").textContent =
    message ||
    `${app.destination.paths.length} item(s) / ${payload.mode} / ${payload.conflictMode} / ${
      targetPath ? labelForPath(targetPath) : "No target"
    }`;
  document.getElementById("destination-send").disabled = !targetPath;
  document.getElementById("destination-target-count").textContent = `${targets.length}`;
  document.getElementById("destination-target-list").innerHTML = targets.length
    ? targets
        .map((target, index) => {
          const detail = target.detail || target.path;
          const meter = target.kind === "drive" ? driveMeterMarkup(target) : "";
          return `<button type="button" class="${destinationTargetClass(
            target,
            targetPath
          )}" data-destination-target-index="${index}" title="${escapeHtml(target.path)}">
            <span class="destination-code">${escapeHtml(destinationKindLabel(target.kind))}</span>
            <span class="destination-target-text">
              <strong>${escapeHtml(target.name || labelForPath(target.path))}</strong>
              <small>${escapeHtml(target.path)}</small>
              ${meter}
            </span>
            <em>${escapeHtml(detail)}</em>
          </button>`;
        })
        .join("")
    : `<div class="empty-state">No destinations</div>`;

  const selection = destinationSelectionItems();
  document.getElementById("destination-selection-count").textContent = `${selection.length}`;
  document.getElementById("destination-selection-list").innerHTML = selection.length
    ? selection
        .slice(0, 24)
        .map(
          (item, index) => `<div class="destination-selection-row">
            <span>${index + 1}</span>
            <strong title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</strong>
            <small>${escapeHtml(item.kind || "")}</small>
          </div>`
        )
        .join("") +
      (selection.length > 24 ? `<div class="empty-state">${escapeHtml(selection.length - 24)} more</div>` : "")
    : `<div class="empty-state">No selection</div>`;
}

function setDestinationTarget(targetPath) {
  document.getElementById("destination-target").value = targetPath || "";
  renderDestinationDialog();
}

async function openDestinationDialog(paneName = app.activePane) {
  const paths = selectedPaths(paneName);
  if (!paths.length) {
    return showToast("Select items first");
  }
  await loadState();
  app.activePane = paneName;
  app.destination = {
    paneName,
    paths,
    targets: []
  };
  document.getElementById("destination-target").value = tabOf(otherPane(paneName)).path;
  document.getElementById("destination-mode").value = "copy";
  document.getElementById("destination-conflict").value = "unique";
  renderDestinationDialog();
  const dialog = document.getElementById("destination-dialog");
  dialog.showModal();
  document.getElementById("destination-target")?.select();
}

function previewDestinationInTransfer() {
  if (!app.destination?.paths?.length) {
    return showToast("Select items first");
  }
  const payload = destinationTransferPayload();
  if (!payload.targetDir) {
    return showToast("Choose a target folder");
  }
  document.getElementById("destination-dialog")?.close();
  openTransferDialogWithPaths(app.destination.paneName, app.destination.paths, {
    targetDir: payload.targetDir,
    mode: payload.mode,
    conflictMode: payload.conflictMode
  });
}

async function applyDestinationTransfer() {
  if (!app.destination?.paths?.length) {
    return showToast("Select items first");
  }
  const payload = destinationTransferPayload();
  if (!payload.targetDir) {
    return showToast("Choose a target folder");
  }
  document.getElementById("destination-summary").textContent = "Previewing...";
  document.getElementById("destination-send").disabled = true;
  const plan = await request("/api/transfer/preview", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (!plan.canApply) {
    renderDestinationDialog(`Review needed / ${transferCountsText(plan.counts)}`);
    previewDestinationInTransfer();
    return;
  }
  document.getElementById("destination-summary").textContent = "Sending...";
  const result = await request("/api/transfer", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  await Promise.all([refreshPane("left"), refreshPane("right")]);
  await syncStateAndChrome();
  document.getElementById("destination-dialog")?.close();
  showToast(`${result.mode === "move" ? "Moved" : "Copied"} ${result.transferred.length} item(s)`);
}

function isZipPath(itemPath) {
  return String(itemPath || "").toLowerCase().endsWith(".zip");
}

function defaultArchiveFileName(paths) {
  if (paths.length === 1) {
    const base = labelForPath(paths[0]);
    const dotIndex = base.lastIndexOf(".");
    const stem = dotIndex > 0 ? base.slice(0, dotIndex) : base;
    return `${stem || "Archive"}.zip`;
  }
  return "Archive.zip";
}

function defaultExtractFolderName(archivePath) {
  const base = labelForPath(archivePath || "Extracted");
  return isZipPath(base) ? base.slice(0, -4) || "Extracted" : base;
}

function openArchiveDialogForPaths(paneName, paths, options = {}) {
  if (!paths.length) {
    return showToast("Select items first");
  }
  const archivePath = paths.find(isZipPath) || "";
  app.archive = { paneName, paths, archivePath };
  document.getElementById("archive-name").value = options.defaultName || defaultArchiveFileName(paths);
  document.getElementById("archive-target").value = tabOf(otherPane(paneName)).path;
  document.getElementById("archive-create-summary").textContent = `${paths.length} selected`;
  document.getElementById("archive-path").value = archivePath;
  document.getElementById("archive-extract-target").value = tabOf(otherPane(paneName)).path;
  document.getElementById("archive-folder").value = defaultExtractFolderName(archivePath);
  document.getElementById("archive-extract-summary").textContent = archivePath
    ? labelForPath(archivePath)
    : "No ZIP selected";
  document.getElementById("archive-dialog").showModal();
  document.getElementById(archivePath ? "archive-folder" : "archive-name").focus();
}

function openArchiveDialog(paneName) {
  return openArchiveDialogForPaths(paneName, selectedPaths(paneName));
}

async function createArchiveFromForm() {
  if (!app.archive?.paths?.length) {
    return showToast("Select items first");
  }
  document.getElementById("archive-create-summary").textContent = "Creating...";
  const result = await request("/api/archive/create", {
    method: "POST",
    body: JSON.stringify({
      paths: app.archive.paths,
      name: document.getElementById("archive-name").value,
      targetDir: document.getElementById("archive-target").value
    })
  });
  await Promise.all([refreshPane(app.archive.paneName), refreshPane(otherPane(app.archive.paneName))]);
  await syncStateAndChrome();
  document.getElementById("archive-create-summary").textContent = labelForPath(result.archive);
  showToast("ZIP created");
}

async function extractArchiveFromForm() {
  const archive = document.getElementById("archive-path").value;
  if (!archive) {
    return showToast("Select a ZIP first");
  }
  document.getElementById("archive-extract-summary").textContent = "Extracting...";
  const result = await request("/api/archive/extract", {
    method: "POST",
    body: JSON.stringify({
      archive,
      targetDir: document.getElementById("archive-extract-target").value,
      folderName: document.getElementById("archive-folder").value
    })
  });
  await Promise.all([refreshPane(app.archive.paneName), refreshPane(otherPane(app.archive.paneName))]);
  await syncStateAndChrome();
  document.getElementById("archive-extract-summary").textContent = labelForPath(result.extractedDir);
  showToast("ZIP extracted");
}

function openPropertiesDialog(paneName) {
  const selection = selectedPaths(paneName);
  const paths = selection.length ? selection : [tabOf(paneName).path];
  app.properties = { paneName, paths, report: null, diagnostics: null };
  document.getElementById("properties-recursive").checked = true;
  document.getElementById("properties-hash").checked = false;
  document.getElementById("properties-hash-algorithm").value = "sha256";
  document.getElementById("properties-max-entries").value = "20000";
  document.getElementById("properties-max-hash").value = "128";
  document.getElementById("properties-summary").textContent = `${paths.length} item(s) ready`;
  document.getElementById("properties-diagnostics").innerHTML = "";
  document.getElementById("properties-results").innerHTML = "";
  document.getElementById("properties-dialog").showModal();
  runPropertiesReport().catch((error) => {
    document.getElementById("properties-summary").textContent = error.message;
  });
}

function attributeModeFromForm(key) {
  const value = document.getElementById(`attributes-${key}`)?.value;
  return value === "set" || value === "clear" ? value : "keep";
}

function selectedAttributeCount(paneName, paths, key) {
  return paths.reduce((count, itemPath) => {
    const entry = entryForPath(paneName, itemPath);
    return count + (entryHasAttribute(entry, key) ? 1 : 0);
  }, 0);
}

function openAttributesDialog(paneName) {
  const paths = selectedPaths(paneName);
  if (!paths.length) {
    return showToast("Select items first");
  }
  app.attributes = { paneName, paths };
  document.getElementById("attributes-selection").textContent = `${paths.length} selected`;
  for (const definition of editableAttributeDefinitions) {
    document.getElementById(`attributes-${definition.key}`).value = "keep";
    const count = selectedAttributeCount(paneName, paths, definition.key);
    document.getElementById(`attributes-${definition.key}-current`).textContent =
      count === paths.length ? "All set" : count ? `${count}/${paths.length} set` : "None set";
  }
  document.getElementById("attributes-summary").textContent = "Ready";
  document.getElementById("attributes-dialog").showModal();
}

async function applyAttributesFromForm() {
  const paths = app.attributes?.paths || [];
  if (!paths.length) {
    return showToast("Select items first");
  }
  const attributes = Object.fromEntries(
    editableAttributeDefinitions.map((definition) => [definition.key, attributeModeFromForm(definition.key)])
  );
  if (!Object.values(attributes).some((mode) => mode !== "keep")) {
    return showToast("Choose at least one attribute change");
  }
  document.getElementById("attributes-summary").textContent = "Applying...";
  const result = await request("/api/attributes/set", {
    method: "POST",
    body: JSON.stringify({ paths, attributes })
  });
  await Promise.all([refreshPane(app.attributes.paneName), refreshPane(otherPane(app.attributes.paneName))]);
  await syncStateAndChrome();
  const count = result.count || result.changed?.length || paths.length;
  const message = `Updated attributes for ${count} item${count === 1 ? "" : "s"}`;
  document.getElementById("attributes-summary").textContent = message;
  document.getElementById("attributes-dialog").close();
  setStatus(message);
  showToast(message);
  return result;
}

function localDateTimeInputValue(value) {
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(value);
  const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19);
}

function isoFromLocalDateTime(value, label) {
  const parsed = Date.parse(value);
  if (!value || !Number.isFinite(parsed)) {
    throw new Error(`${label} time is required.`);
  }
  return new Date(parsed).toISOString();
}

function setTimestampInputsToNow() {
  const now = localDateTimeInputValue(Date.now());
  for (const definition of editableTimestampDefinitions) {
    document.getElementById(`timestamps-${definition.key}-enabled`).checked = true;
    document.getElementById(`timestamps-${definition.key}`).value = now;
  }
}

function openTimestampsDialog(paneName) {
  const paths = selectedPaths(paneName);
  if (!paths.length) {
    return showToast("Select items first");
  }
  const firstEntry = entryForPath(paneName, paths[0]);
  app.timestamps = { paneName, paths };
  document.getElementById("timestamps-selection").textContent = `${paths.length} selected`;
  for (const definition of editableTimestampDefinitions) {
    const value = firstEntry?.[definition.key] ?? Date.now();
    document.getElementById(`timestamps-${definition.key}-enabled`).checked = false;
    document.getElementById(`timestamps-${definition.key}`).value = localDateTimeInputValue(value);
    document.getElementById(`timestamps-${definition.key}-current`).textContent = formatDate(value);
  }
  document.getElementById("timestamps-summary").textContent = "Ready";
  document.getElementById("timestamps-dialog").showModal();
}

async function applyTimestampsFromForm() {
  const paths = app.timestamps?.paths || [];
  if (!paths.length) {
    return showToast("Select items first");
  }
  const timestamps = {};
  for (const definition of editableTimestampDefinitions) {
    if (document.getElementById(`timestamps-${definition.key}-enabled`).checked) {
      timestamps[definition.key] = isoFromLocalDateTime(
        document.getElementById(`timestamps-${definition.key}`).value,
        definition.label
      );
    }
  }
  if (!Object.keys(timestamps).length) {
    return showToast("Choose at least one timestamp");
  }
  document.getElementById("timestamps-summary").textContent = "Applying...";
  const result = await request("/api/timestamps/set", {
    method: "POST",
    body: JSON.stringify({ paths, timestamps })
  });
  await Promise.all([refreshPane(app.timestamps.paneName), refreshPane(otherPane(app.timestamps.paneName))]);
  await syncStateAndChrome();
  const count = result.count || result.changed?.length || paths.length;
  const message = `Updated timestamps for ${count} item${count === 1 ? "" : "s"}`;
  document.getElementById("timestamps-summary").textContent = message;
  document.getElementById("timestamps-dialog").close();
  setStatus(message);
  showToast(message);
  return result;
}

function windowsPropertiesTarget(paneName, entryPath = null) {
  const tab = tabOf(paneName);
  const selection = selectedPaths(paneName);
  if (entryPath && (!selection.length || !selection.some((itemPath) => samePath(itemPath, entryPath)))) {
    return entryPath;
  }
  return selection[0] || tab.focusedPath || tab.path;
}

async function openWindowsProperties(paneName, entryPath = null) {
  const targetPath = windowsPropertiesTarget(paneName, entryPath);
  if (!targetPath) {
    showToast("Select something first");
    return null;
  }
  const result = await request("/api/windows-properties", {
    method: "POST",
    body: JSON.stringify({ path: targetPath })
  });
  const message = `Windows Properties: ${labelForPath(result.path || targetPath)}`;
  setStatus(message);
  showToast(message);
  return result;
}

function shellVerbTargetForDialog(paneName, entryPath = null) {
  const targetPath = windowsPropertiesTarget(paneName, entryPath);
  if (!targetPath || isZipVirtualPath(targetPath)) {
    return "";
  }
  return targetPath;
}

function shellVerbDangerClass(verb) {
  return verb?.isDangerous ? " danger" : "";
}

function renderShellVerbsDialog(message = "") {
  const state = app.shellVerbs;
  if (!state) {
    return;
  }
  const report = state.report || {};
  const verbs = Array.isArray(report.verbs) ? report.verbs : [];
  document.getElementById("shell-verbs-summary").textContent =
    message || (report.available === false ? report.reason || "Shell verbs unavailable" : `${verbs.length} verb(s)`);
  document.getElementById("shell-verbs-target").innerHTML = `<div class="shell-verbs-target-row">
    <span>${escapeHtml(report.targetKind === "directory" ? "DIR" : report.targetKind === "file" ? "FILE" : "ITEM")}</span>
    <strong title="${escapeHtml(state.targetPath)}">${escapeHtml(report.name || labelForPath(state.targetPath))}</strong>
    <small>${escapeHtml(state.targetPath)}</small>
  </div>`;
  document.getElementById("shell-verbs-list").innerHTML = verbs.length
    ? verbs
        .map(
          (verb) => `<button type="button" class="shell-verb-button${shellVerbDangerClass(verb)}" data-shell-verb-id="${escapeHtml(
            verb.id
          )}" data-shell-verb-name="${escapeHtml(verb.name)}" title="${escapeHtml(verb.rawName || verb.name)}">
            <span>${escapeHtml(verb.name)}</span>
            <kbd>${escapeHtml(verb.isDefault ? "default" : `#${verb.rawIndex}`)}</kbd>
          </button>`
        )
        .join("")
    : `<div class="empty-state">${escapeHtml(report.available === false ? report.reason || "Unavailable" : "No shell verbs")}</div>`;
}

async function loadShellVerbs() {
  const state = app.shellVerbs;
  if (!state?.targetPath) {
    return showToast("Select something first");
  }
  document.getElementById("shell-verbs-summary").textContent = "Reading shell verbs...";
  document.getElementById("shell-verbs-output").textContent = "";
  const params = new URLSearchParams({ path: state.targetPath });
  const report = await request(`/api/shell/verbs?${params}`);
  state.report = report;
  renderShellVerbsDialog();
  return report;
}

async function openShellVerbsDialog(paneName = app.activePane, entryPath = null) {
  const targetPath = shellVerbTargetForDialog(paneName, entryPath);
  if (!targetPath) {
    return showToast("Select a real filesystem item first");
  }
  app.activePane = paneName;
  app.shellVerbs = { paneName, targetPath, report: null };
  renderShellVerbsDialog("Reading shell verbs...");
  document.getElementById("shell-verbs-output").textContent = "";
  document.getElementById("shell-verbs-dialog").showModal();
  try {
    await loadShellVerbs();
  } catch (error) {
    document.getElementById("shell-verbs-summary").textContent = error.message;
    document.getElementById("shell-verbs-output").textContent = error.message;
    showToast(error.message);
  }
}

async function runShellVerb(verbId, verbName) {
  const state = app.shellVerbs;
  if (!state?.targetPath) {
    return showToast("Select something first");
  }
  const verb =
    state.report?.verbs?.find((item) => String(item.id) === String(verbId) && item.name === verbName) ||
    state.report?.verbs?.find((item) => String(item.id) === String(verbId));
  document.getElementById("shell-verbs-summary").textContent = `Running ${verb?.name || verbName || "shell verb"}...`;
  const result = await request("/api/shell/verb", {
    method: "POST",
    body: JSON.stringify({
      path: state.targetPath,
      verbId,
      verbName: verb?.name || verbName
    })
  });
  document.getElementById("shell-verbs-output").textContent = JSON.stringify(result, null, 2);
  renderShellVerbsDialog(`Ran ${result.verb?.name || verb?.name || "shell verb"}`);
  setStatus(`Shell verb: ${result.verb?.name || verb?.name || "done"}`);
  showToast("Shell verb launched");
  setTimeout(() => refreshPane(state.paneName).catch(() => {}), 1200);
  return result;
}

function propertiesPayload() {
  return {
    paths: app.properties?.paths || [],
    recursive: document.getElementById("properties-recursive").checked,
    hash: document.getElementById("properties-hash").checked,
    hashAlgorithm: document.getElementById("properties-hash-algorithm").value,
    maxEntries: Number(document.getElementById("properties-max-entries").value || 20000),
    maxHashBytes: Number(document.getElementById("properties-max-hash").value || 128) * 1024 * 1024
  };
}

function propertyHashText(item) {
  if (!item.hash) {
    return "";
  }
  if (item.hash.skipped) {
    return item.hash.reason || "Skipped";
  }
  return item.hash.value || "";
}

function renderPropertiesReport(report) {
  app.properties.report = report;
  const summary = report.summary || {};
  document.getElementById("properties-summary").innerHTML = `
    <div><span class="field-label">Selected</span><strong>${summary.available}/${summary.selected}</strong></div>
    <div><span class="field-label">Size</span><strong>${formatSize(summary.bytes)}</strong></div>
    <div><span class="field-label">Files</span><strong>${summary.files}</strong></div>
    <div><span class="field-label">Folders</span><strong>${summary.folders}</strong></div>
    <div><span class="field-label">Scanned</span><strong>${summary.scanned}</strong></div>
    <div><span class="field-label">Skipped</span><strong>${summary.skipped}${summary.truncated ? " / truncated" : ""}</strong></div>
  `;
  const rows = document.getElementById("properties-results");
  rows.innerHTML = report.items.length
    ? report.items
        .map(
          (item) =>
            `<div class="properties-row">
              <span class="properties-index">${item.index + 1}</span>
              <span>
                <strong title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</strong>
                <small>${escapeHtml(item.path)}</small>
              </span>
              <span>${escapeHtml(item.kind)}</span>
              <span>${formatSize(item.size)}</span>
              <span>${item.fileCount} files / ${item.folderCount} folders</span>
              <span>${formatDate(item.modified)}</span>
              <code title="${escapeHtml(propertyHashText(item))}">${escapeHtml(propertyHashText(item))}</code>
            </div>`
        )
        .join("")
    : `<div class="empty-state">No available items</div>`;
}

function pathDiagnosticStatus(report) {
  const hasHardError = report.errors?.some((item) => ["stat", "readDir"].includes(item.stage));
  if (hasHardError || (report.check && !report.reachable)) {
    return { level: "error", text: "Blocked" };
  }
  if (!report.check) {
    return { level: "warn", text: "Parsed" };
  }
  if (
    report.isNetwork ||
    report.watch?.available === false ||
    Number(report.timings?.statMs) > 1000 ||
    Number(report.timings?.readDirMs) > 1000
  ) {
    return { level: "warn", text: "Watch" };
  }
  return { level: "ok", text: "Healthy" };
}

function pathDiagnosticKindText(report) {
  if (report.kind === "unc") {
    return `UNC ${report.server || "server"}\\${report.share || "share"}`;
  }
  if (report.mappedDrive?.mapped) {
    return `${report.driveLetter}: mapped`;
  }
  if (report.kind === "drive") {
    return `${report.driveLetter || ""}: drive`;
  }
  return report.kind || "path";
}

function pathDiagnosticSpaceText(report) {
  if (!report.space?.available) {
    return "Unknown";
  }
  const free = formatSize(report.space.freeBytes);
  const total = formatSize(report.space.totalBytes);
  const percent = Number(report.space.freePercent);
  return `${free} free / ${total}${Number.isFinite(percent) ? ` (${Math.round(percent)}%)` : ""}`;
}

function pathDiagnosticWatchText(report) {
  if (!report.check || !report.isDirectory) {
    return "Not tested";
  }
  if (!report.watch) {
    return "Unknown";
  }
  return report.watch.available ? "Available" : "Fallback";
}

function pathDiagnosticTimingText(report) {
  const parts = [
    ["stat", report.timings?.statMs],
    ["read", report.timings?.readDirMs],
    ["total", report.timings?.totalMs]
  ]
    .filter(([, value]) => Number.isFinite(Number(value)))
    .map(([label, value]) => `${label} ${formatMilliseconds(value)}`);
  return parts.join(" / ") || "Parse only";
}

function renderPathDiagnostics(report) {
  app.properties.diagnostics = report;
  const status = pathDiagnosticStatus(report);
  const metrics = [
    ["Kind", pathDiagnosticKindText(report)],
    ["Reach", report.reachable ? "Reachable" : report.check ? "Unavailable" : "Not checked"],
    ["Entries", Number.isFinite(Number(report.entryCount)) ? `${report.entryCount}` : report.isDirectory ? "Unknown" : report.targetKind],
    ["Watcher", pathDiagnosticWatchText(report)],
    ["Space", pathDiagnosticSpaceText(report)],
    ["Timing", pathDiagnosticTimingText(report)]
  ];
  const mapped = report.mappedDrive?.mapped
    ? `<div class="path-diagnostic-mapped">Mapped remote: <code>${escapeHtml(report.mappedDrive.remote)}</code></div>`
    : "";
  const errors = report.errors?.length
    ? `<div class="path-diagnostic-errors">${report.errors
        .map((item) => `<span title="${escapeHtml(item.message)}">${escapeHtml(item.stage)}: ${escapeHtml(item.code)}</span>`)
        .join("")}</div>`
    : "";
  const recommendations = (report.recommendations || [])
    .map((message) => `<li>${escapeHtml(message)}</li>`)
    .join("");
  document.getElementById("properties-diagnostics").innerHTML = `
    <div class="path-diagnostic-head">
      <strong>Path Health</strong>
      <span class="path-health path-health-${status.level}">${escapeHtml(status.text)}</span>
      <code title="${escapeHtml(report.resolved)}">${escapeHtml(report.resolved)}</code>
    </div>
    <div class="path-diagnostic-grid">
      ${metrics
        .map(
          ([label, value]) =>
            `<div><span class="field-label">${escapeHtml(label)}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong></div>`
        )
        .join("")}
    </div>
    ${mapped}
    ${errors}
    <ul class="path-diagnostic-recommendations">${recommendations}</ul>
  `;
}

async function runPathDiagnostics() {
  const paneName = app.properties?.paneName || app.activePane;
  const targetPath = app.properties?.paths?.[0] || tabOf(paneName).path;
  if (!targetPath) {
    return showToast("Select a path first");
  }
  const output = document.getElementById("properties-diagnostics");
  output.innerHTML = `<div class="path-diagnostic-loading">Diagnosing ${escapeHtml(labelForPath(targetPath))}...</div>`;
  const params = new URLSearchParams({
    path: targetPath,
    timeoutMs: "3500",
    sampleLimit: "12"
  });
  const report = await request(`/api/path/diagnostics?${params}`);
  renderPathDiagnostics(report);
  const status = pathDiagnosticStatus(report);
  setStatus(`Path health ${status.text.toLowerCase()} / ${pathDiagnosticTimingText(report)}`);
  showToast("Path health ready");
  return report;
}

async function runPropertiesReport() {
  if (!app.properties?.paths?.length) {
    return showToast("Select an item first");
  }
  document.getElementById("properties-summary").textContent = "Analyzing...";
  const report = await request("/api/properties", {
    method: "POST",
    body: JSON.stringify(propertiesPayload())
  });
  renderPropertiesReport(report);
}

async function trashSelected(paneName) {
  const paths = selectedPaths(paneName);
  if (!paths.length) {
    return showToast("Select items first");
  }
  if (confirmTrashEnabled() && !confirm(`Move ${paths.length} item(s) to app trash?`)) {
    return;
  }
  const result = await request("/api/trash", {
    method: "POST",
    body: JSON.stringify({ paths })
  });
  await refreshPane(paneName);
  await syncStateAndChrome();
  showToast(`Moved to ${result.trashDir}`);
}

async function recycleSelected(paneName) {
  const paths = selectedPaths(paneName);
  if (!paths.length) {
    return showToast("Select items first");
  }
  const ok = confirm(
    `Move ${paths.length} item(s) to the Windows Recycle Bin? Restore them from Windows if needed.`
  );
  if (!ok) return;
  const result = await request("/api/recycle", {
    method: "POST",
    body: JSON.stringify({ paths })
  });
  await Promise.all([refreshPane("left"), refreshPane("right")]);
  await syncStateAndChrome();
  showToast(`Recycled ${result.recycled?.length || paths.length} item(s)`);
}

async function deleteSelectedPermanently(paneName) {
  const paths = selectedPaths(paneName);
  if (!paths.length) {
    return showToast("Select items first");
  }
  const typed = prompt(
    `Permanently delete ${paths.length} item(s)? This cannot be restored from App Trash or Windows Recycle Bin. Type DELETE to confirm.`
  );
  if (typed !== "DELETE") {
    return showToast("Permanent delete canceled");
  }
  const result = await request("/api/delete", {
    method: "POST",
    body: JSON.stringify({ paths })
  });
  await Promise.all([refreshPane("left"), refreshPane("right")]);
  await syncStateAndChrome();
  showToast(`Deleted ${result.deleted?.length || paths.length} item(s) permanently`);
}

function selectedTrashPaths() {
  return [...app.trashBrowser.selected];
}

function selectedWindowsRecyclePaths() {
  return [...app.trashBrowser.windowsSelected];
}

function trashSummaryText(summary = app.trashBrowser.summary) {
  const count = Number(summary?.count || 0);
  const bytes = Number(summary?.bytes || 0);
  const selected = app.trashBrowser.selected.size;
  const base = `${count} item${count === 1 ? "" : "s"} / ${formatSize(bytes)}`;
  return selected ? `${base} / ${selected} selected` : base;
}

function windowsRecycleSummaryText(summary = app.trashBrowser.windowsSummary) {
  if (summary?.available === false) {
    return summary.reason || "Windows Recycle Bin unavailable";
  }
  const total = Number(summary?.total ?? summary?.count ?? 0);
  const shown = Number(summary?.count ?? app.trashBrowser.windowsItems.length);
  const bytes = Number(summary?.bytes || 0);
  const selected = app.trashBrowser.windowsSelected.size;
  const truncated = summary?.truncated ? ` / showing ${shown}` : "";
  const base = `${total} item${total === 1 ? "" : "s"}${truncated} / ${formatSize(bytes)}`;
  return selected ? `${base} / ${selected} selected` : base;
}

function trashRowMarkup(item) {
  const checked = app.trashBrowser.selected.has(item.path) ? " checked" : "";
  const original = item.originalPath || "Original path unavailable";
  const trashedAt = item.trashedAt ? formatDate(Number(item.trashedAt)) : "";
  return `<div class="trash-row${checked ? " selected" : ""}">
    <input type="checkbox" data-trash-select="${escapeHtml(item.path)}"${checked} aria-label="Select ${escapeHtml(
      item.name
    )}" />
    <span>
      <strong title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</strong>
      <small title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</small>
    </span>
    <span>
      <strong title="${escapeHtml(original)}">${escapeHtml(labelForPath(original))}</strong>
      <small title="${escapeHtml(original)}">${escapeHtml(original)}</small>
    </span>
    <span class="trash-kind">${escapeHtml(item.isDirectory ? "Folder" : item.kind || "File")}</span>
    <span>${formatSize(item.size)}</span>
    <span><strong>${escapeHtml(trashedAt)}</strong><small>${escapeHtml(item.batchName || "")}</small></span>
  </div>`;
}

function windowsRecycleRowMarkup(item) {
  const checked = app.trashBrowser.windowsSelected.has(item.path) ? " checked" : "";
  const original = item.originalPath || item.originalLocation || "Original path unavailable";
  const deleted = item.dateDeletedText || "";
  return `<div class="trash-row windows-trash-row${checked ? " selected" : ""}">
    <input type="checkbox" data-windows-recycle-select="${escapeHtml(item.path)}"${checked} aria-label="Select ${escapeHtml(
      item.name
    )}" />
    <span>
      <strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
      <small title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</small>
    </span>
    <span>
      <strong title="${escapeHtml(original)}">${escapeHtml(labelForPath(original))}</strong>
      <small title="${escapeHtml(original)}">${escapeHtml(original)}</small>
    </span>
    <span class="trash-kind">${escapeHtml(item.isDirectory ? "Folder" : item.type || "File")}</span>
    <span>${escapeHtml(item.sizeText || formatSize(item.size))}</span>
    <span><strong>${escapeHtml(deleted)}</strong><small>${escapeHtml(item.originalLocation || "")}</small></span>
  </div>`;
}

function renderTrashBrowser() {
  const summary = document.getElementById("trash-summary");
  const results = document.getElementById("trash-results");
  if (!summary || !results) {
    return;
  }
  const mode = app.trashBrowser.mode === "windows" ? "windows" : "app";
  document.querySelectorAll("[data-trash-mode]").forEach((button) => {
    const active = button.dataset.trashMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const restoreButton = document.querySelector("[data-trash-action='restore']");
  const deleteButton = document.querySelector("[data-trash-action='delete']");
  const openWindowsButton = document.querySelector("[data-trash-action='open-windows']");
  if (restoreButton) restoreButton.textContent = mode === "windows" ? "Restore In Windows" : "Restore To Active";
  if (deleteButton) deleteButton.hidden = mode === "windows";
  if (openWindowsButton) openWindowsButton.hidden = mode !== "windows";
  if (mode === "windows") {
    summary.textContent = `${windowsRecycleSummaryText()} / restores return to original locations`;
    results.innerHTML = app.trashBrowser.windowsItems.length
      ? app.trashBrowser.windowsItems.map(windowsRecycleRowMarkup).join("")
      : `<div class="empty-state">Windows Recycle Bin is empty</div>`;
    return;
  }
  summary.textContent = `${trashSummaryText()} / restore target: ${tabOf(app.activePane).path}`;
  results.innerHTML = app.trashBrowser.items.length
    ? app.trashBrowser.items.map(trashRowMarkup).join("")
    : `<div class="empty-state">App trash is empty</div>`;
}

function renderAppTrash() {
  renderTrashBrowser();
}

async function loadAppTrash() {
  const data = await request("/api/app-trash");
  app.trashBrowser.summary = data;
  app.trashBrowser.items = data.items || [];
  const available = new Set(app.trashBrowser.items.map((item) => item.path));
  app.trashBrowser.selected = new Set(
    [...app.trashBrowser.selected].filter((itemPath) => available.has(itemPath))
  );
  renderAppTrash();
  return data;
}

async function loadWindowsRecycleBin() {
  const data = await request("/api/windows-recycle-bin?limit=1000");
  app.trashBrowser.windowsSummary = data;
  app.trashBrowser.windowsItems = data.items || [];
  const available = new Set(app.trashBrowser.windowsItems.map((item) => item.path));
  app.trashBrowser.windowsSelected = new Set(
    [...app.trashBrowser.windowsSelected].filter((itemPath) => available.has(itemPath))
  );
  renderTrashBrowser();
  return data;
}

async function openAppTrashDialog() {
  app.trashBrowser.mode = "app";
  app.trashBrowser.selected = new Set();
  await loadAppTrash();
  document.getElementById("trash-dialog").showModal();
}

async function openWindowsRecycleDialog() {
  app.trashBrowser.mode = "windows";
  app.trashBrowser.windowsSelected = new Set();
  await loadWindowsRecycleBin();
  document.getElementById("trash-dialog").showModal();
}

async function switchTrashMode(mode) {
  app.trashBrowser.mode = mode === "windows" ? "windows" : "app";
  if (app.trashBrowser.mode === "windows") {
    await loadWindowsRecycleBin();
  } else {
    await loadAppTrash();
  }
}

async function restoreSelectedTrash() {
  const paths = selectedTrashPaths();
  if (!paths.length) {
    return showToast("Select trash items first");
  }
  const targetDir = tabOf(app.activePane).path;
  const result = await request("/api/app-trash/restore", {
    method: "POST",
    body: JSON.stringify({ paths, targetDir })
  });
  app.trashBrowser.selected = new Set();
  await Promise.all([refreshPane("left"), refreshPane("right")]);
  await syncStateAndChrome();
  await loadAppTrash();
  showToast(`Restored ${result.restored?.length || paths.length} item(s)`);
}

async function restoreSelectedWindowsRecycle() {
  const paths = selectedWindowsRecyclePaths();
  if (!paths.length) {
    return showToast("Select Windows Recycle Bin items first");
  }
  const result = await request("/api/windows-recycle-bin/restore", {
    method: "POST",
    body: JSON.stringify({ paths })
  });
  app.trashBrowser.windowsSelected = new Set();
  await Promise.all([refreshPane("left"), refreshPane("right")]);
  await syncStateAndChrome();
  await loadWindowsRecycleBin();
  showToast(`Restored ${result.restored?.length || paths.length} item(s)`);
}

async function openWindowsRecycleInExplorer() {
  await launchShellLocation("recycleBin");
}

async function deleteSelectedTrash() {
  const paths = selectedTrashPaths();
  if (!paths.length) {
    return showToast("Select trash items first");
  }
  if (confirmTrashEnabled() && !confirm(`Permanently delete ${paths.length} app trash item(s)?`)) {
    return;
  }
  const result = await request("/api/app-trash/delete", {
    method: "POST",
    body: JSON.stringify({ paths })
  });
  app.trashBrowser.selected = new Set();
  await syncStateAndChrome();
  await loadAppTrash();
  showToast(`Deleted ${result.deleted?.length || paths.length} item(s)`);
}

function duplicateTab(paneName) {
  const pane = panes[paneName];
  const current = tabOf(paneName);
  pane.tabs.push({
    path: current.path,
    entries: current.entries,
    selected: new Set(),
    history: [],
    future: [],
    filter: "",
    kindFilter: normalizeKindFilter(current.kindFilter),
    labelFilter: current.labelFilter || "all",
    columns: normalizeColumns(current.columns),
    columnWidths: normalizeColumnWidths(current.columnWidths),
    sortKey: current.sortKey,
    sortDir: current.sortDir,
    viewMode: current.viewMode,
    searchMode: false,
    virtualMode: current.virtualMode || "",
    virtual: current.virtual ? { ...current.virtual } : null,
    title: current.title,
    locked: false,
    parent: current.parent,
    folderSignature: current.folderSignature,
    listingIncludesDimensions: current.listingIncludesDimensions === true,
    listingIncludesLinks: current.listingIncludesLinks === true,
    listingIncludesAttributes: current.listingIncludesAttributes === true,
    folderWatchVersion: null,
    lastLoadTiming: current.lastLoadTiming || null,
    visibleEntriesRevision: 0,
    focusedPath: null,
    anchorPath: null
  });
  pane.activeTab = pane.tabs.length - 1;
  app.activePane = paneName;
  renderPane(paneName);
  scheduleStateSave();
  focusPaneList(paneName);
  return true;
}

function tabShellForPath(sourceTab, targetPath) {
  return {
    path: targetPath,
    entries: [],
    selected: new Set(),
    history: [],
    future: [],
    filter: "",
    kindFilter: normalizeKindFilter(sourceTab.kindFilter),
    labelFilter: sourceTab.labelFilter || "all",
    columns: normalizeColumns(sourceTab.columns),
    columnWidths: normalizeColumnWidths(sourceTab.columnWidths),
    sortKey: sourceTab.sortKey,
    sortDir: sourceTab.sortDir,
    viewMode: sourceTab.viewMode,
    searchMode: false,
    virtualMode: "",
    virtual: null,
    title: labelForPath(targetPath),
    locked: false,
    parent: null,
    folderSignature: null,
    focusedPath: null,
    anchorPath: null
  };
}

function reopenableTabSnapshot(tab) {
  return {
    path: tab.path,
    title: tab.title,
    parent: tab.parent,
    history: Array.isArray(tab.history) ? tab.history.slice(-20) : [],
    future: Array.isArray(tab.future) ? tab.future.slice(-20) : [],
    filter: tab.filter || "",
    kindFilter: normalizeKindFilter(tab.kindFilter),
    labelFilter: tab.labelFilter || "all",
    columns: normalizeColumns(tab.columns),
    columnWidths: normalizeColumnWidths(tab.columnWidths),
    sortKey: tab.sortKey || "name",
    sortDir: tab.sortDir === "desc" ? "desc" : "asc",
    viewMode: ["details", "compact", "tiles"].includes(tab.viewMode) ? tab.viewMode : "details",
    locked: tab.locked === true
  };
}

function rememberClosedTab(paneName, tab) {
  if (!isPaneName(paneName) || !tab?.path) {
    return;
  }
  app.closedTabs = [
    {
      paneName,
      tab: reopenableTabSnapshot(tab),
      closedAt: new Date().toISOString()
    },
    ...(app.closedTabs || [])
  ].slice(0, 20);
}

async function openFolderInNewTab(paneName, targetPath) {
  if (!isPaneName(paneName) || !targetPath) {
    return false;
  }
  const pane = panes[paneName];
  const sourceIndex = pane.activeTab;
  const insertIndex = sourceIndex + 1;
  pane.tabs.splice(insertIndex, 0, tabShellForPath(tabOf(paneName), targetPath));
  pane.activeTab = insertIndex;
  app.activePane = paneName;
  try {
    await loadPane(paneName, targetPath, false, { allowLockedNavigation: true });
    showToast(`Opened ${labelForPath(targetPath)} in a new tab`);
    focusPaneList(paneName);
    return true;
  } catch (error) {
    pane.tabs.splice(insertIndex, 1);
    pane.activeTab = Math.max(0, Math.min(sourceIndex, pane.tabs.length - 1));
    renderPane(paneName);
    throw error;
  }
}

async function activateTab(paneName, tabIndex) {
  if (!isPaneName(paneName)) {
    return false;
  }
  const pane = panes[paneName];
  const nextIndex = Math.max(0, Math.min(Number(tabIndex) || 0, pane.tabs.length - 1));
  pane.activeTab = nextIndex;
  app.activePane = paneName;
  if (!tabOf(paneName).entries.length && tabOf(paneName).path) {
    await loadPane(paneName, tabOf(paneName).path, false);
  }
  renderAll();
  renderRoots();
  renderInspector();
  scheduleStateSave();
  focusPaneList(paneName);
  return true;
}

async function cyclePaneTab(paneName, direction = 1) {
  if (!isPaneName(paneName)) {
    return false;
  }
  const pane = panes[paneName];
  if (pane.tabs.length < 2) {
    showToast("Only one tab is open");
    return false;
  }
  const nextIndex = (pane.activeTab + direction + pane.tabs.length) % pane.tabs.length;
  return activateTab(paneName, nextIndex);
}

function closeTab(paneName, tabIndex = panes[paneName]?.activeTab || 0) {
  if (!isPaneName(paneName)) {
    return false;
  }
  const pane = panes[paneName];
  if (pane.tabs.length < 2) {
    showToast("Keep at least one tab open");
    return false;
  }
  const closeIndex = Math.max(0, Math.min(Number(tabIndex) || 0, pane.tabs.length - 1));
  const [closedTab] = pane.tabs.splice(closeIndex, 1);
  rememberClosedTab(paneName, closedTab);
  if (pane.activeTab > closeIndex) {
    pane.activeTab -= 1;
  } else if (pane.activeTab >= pane.tabs.length) {
    pane.activeTab = pane.tabs.length - 1;
  }
  app.activePane = paneName;
  renderPane(paneName);
  renderRoots();
  renderInspector();
  scheduleStateSave();
  focusPaneList(paneName);
  showToast(`Closed ${closedTab.title || labelForPath(closedTab.path)}`);
  return true;
}

async function reopenClosedTab(paneName = app.activePane) {
  const closedTabs = app.closedTabs || [];
  const preferredIndex = closedTabs.findIndex((item) => item.paneName === paneName);
  const recordIndex = preferredIndex >= 0 ? preferredIndex : 0;
  const record = closedTabs[recordIndex];
  if (!record?.tab?.path) {
    showToast("No closed tabs to reopen");
    return false;
  }
  app.closedTabs = closedTabs.filter((_, index) => index !== recordIndex);
  const targetPane = isPaneName(record.paneName) ? record.paneName : paneName;
  const pane = panes[targetPane];
  const insertIndex = Math.min(pane.activeTab + 1, pane.tabs.length);
  pane.tabs.splice(insertIndex, 0, normalizeSavedTab(record.tab, record.tab.path));
  pane.activeTab = insertIndex;
  app.activePane = targetPane;
  await loadPane(targetPane, record.tab.path, false, { allowLockedNavigation: true });
  showToast(`Reopened ${labelForPath(record.tab.path)}`);
  focusPaneList(targetPane);
  return true;
}

function toggleTabLock(paneName, tabIndex = panes[paneName]?.activeTab || 0) {
  if (!isPaneName(paneName)) {
    return;
  }
  const pane = panes[paneName];
  const tab = pane.tabs[Number(tabIndex)];
  if (!tab) {
    return;
  }
  tab.locked = !tab.locked;
  renderPane(paneName);
  scheduleStateSave();
  showToast(tab.locked ? "Tab locked" : "Tab unlocked");
}

function setViewMode(paneName, viewMode) {
  if (!["details", "compact", "tiles"].includes(viewMode)) {
    return;
  }
  tabOf(paneName).viewMode = viewMode;
  renderPane(paneName);
  scheduleStateSave();
}

function setKindFilter(paneName, value) {
  if (!isPaneName(paneName)) {
    return;
  }
  const normalized = normalizeKindFilter(value);
  tabOf(paneName).kindFilter = normalized;
  renderPane(paneName);
  updateSelectionReadout();
  scheduleStateSave();
  setStatus(`${paneName}: ${kindFilterLabel(normalized)} kind filter`);
}

function labelFilterLabel(value = "all") {
  const active = value || "all";
  if (active === "all") {
    return "All labels";
  }
  if (active === "any") {
    return "Any label";
  }
  return labelColors.find((item) => item.id === active)?.name || active;
}

function normalizeFilterPresetOptions(options = {}) {
  return {
    filter: String(options.filter || options.text || "").trim(),
    kindFilter: normalizeKindFilter(options.kindFilter),
    labelFilter: String(options.labelFilter || "all").trim() || "all"
  };
}

function filterOptionsFromTab(tab = tabOf(app.activePane)) {
  return normalizeFilterPresetOptions({
    filter: tab.filter || "",
    kindFilter: tab.kindFilter || "all",
    labelFilter: tab.labelFilter || "all"
  });
}

function filterPresetLabel(options = {}) {
  const normalized = normalizeFilterPresetOptions(options);
  const parts = [];
  if (normalized.filter) {
    parts.push(`text:${normalized.filter}`);
  }
  if (normalized.kindFilter !== "all") {
    parts.push(kindFilterLabel(normalized.kindFilter));
  }
  if (normalized.labelFilter !== "all") {
    parts.push(labelFilterLabel(normalized.labelFilter));
  }
  return parts.join(" / ") || "No filters";
}

function filterPresets() {
  if (!app.state) {
    return [];
  }
  if (!Array.isArray(app.state.filterPresets)) {
    app.state.filterPresets = [];
  }
  return app.state.filterPresets;
}

function currentFilterPreset() {
  const presets = filterPresets();
  return presets.find((preset) => preset.id === app.activeFilterPresetId) || presets[0] || null;
}

function defaultFilterPresetName(options = filterOptionsFromTab()) {
  const label = filterPresetLabel(options);
  return label === "No filters" ? "Filter Preset" : label.slice(0, 80);
}

function fillFilterPresetForm(preset = null) {
  const options = normalizeFilterPresetOptions(preset?.options || filterOptionsFromTab());
  document.getElementById("filter-preset-id").value = preset?.id || "";
  document.getElementById("filter-preset-name").value = preset?.name || defaultFilterPresetName(options);
  document.getElementById("filter-preset-text").value = options.filter;
  document.getElementById("filter-preset-kind").innerHTML = renderKindFilterOptions(options.kindFilter);
  document.getElementById("filter-preset-label").innerHTML = renderLabelFilterOptions(options.labelFilter);
  document.getElementById("filter-preset-description").value = preset?.description || "";
  document.getElementById("filter-preset-capture-summary").textContent = `Active pane: ${filterPresetLabel(
    filterOptionsFromTab()
  )}`;
}

function renderFilterPresets() {
  const list = document.getElementById("filter-preset-list");
  if (!list) {
    return;
  }
  const presets = filterPresets();
  if (!app.activeFilterPresetId && presets[0]) {
    app.activeFilterPresetId = presets[0].id;
  }
  const active = currentFilterPreset();
  document.getElementById("filter-preset-summary").textContent = `${presets.length} saved`;
  list.innerHTML = presets.length
    ? presets
        .map(
          (preset) =>
            `<button class="${preset.id === active?.id ? "active" : ""}" data-select-filter-preset="${escapeHtml(
              preset.id
            )}">
              <span>
                <strong>${escapeHtml(preset.name)}</strong>
                ${preset.description ? `<small>${escapeHtml(preset.description)}</small>` : ""}
                <small>${escapeHtml(filterPresetLabel(preset.options))}</small>
              </span>
            </button>`
        )
        .join("")
    : `<div class="empty-state">No filter presets</div>`;
  fillFilterPresetForm(active);
}

function filterPresetFromForm() {
  const id = document.getElementById("filter-preset-id").value || crypto.randomUUID();
  const options = normalizeFilterPresetOptions({
    filter: document.getElementById("filter-preset-text").value,
    kindFilter: document.getElementById("filter-preset-kind").value,
    labelFilter: document.getElementById("filter-preset-label").value
  });
  return {
    id,
    name: document.getElementById("filter-preset-name").value.trim() || defaultFilterPresetName(options),
    description: document.getElementById("filter-preset-description").value.trim(),
    updatedAt: new Date().toISOString(),
    options
  };
}

async function persistFilterPreset(preset) {
  if (!app.state) {
    await loadState();
  }
  const existing = filterPresets().find((item) => item.id === preset.id);
  const saved = {
    ...existing,
    ...preset,
    createdAt: existing?.createdAt || new Date().toISOString()
  };
  app.state.filterPresets = [
    saved,
    ...filterPresets().filter((item) => item.id !== saved.id)
  ].slice(0, 50);
  app.activeFilterPresetId = saved.id;
  await saveStateNow();
  renderFilterPresets();
  renderBackupDialog();
  return saved;
}

async function saveFilterPresetFromForm() {
  const saved = await persistFilterPreset(filterPresetFromForm());
  showToast(`Filter preset saved: ${saved.name}`);
  return saved;
}

async function quickSaveFilterPreset(paneName = app.activePane) {
  app.activePane = paneName;
  await loadState();
  const options = filterOptionsFromTab(tabOf(paneName));
  const saved = await persistFilterPreset({
    id: crypto.randomUUID(),
    name: defaultFilterPresetName(options),
    description: "",
    updatedAt: new Date().toISOString(),
    options
  });
  showToast(`Filter preset saved: ${saved.name}`);
  return saved;
}

function captureFilterPresetFormFromPane() {
  fillFilterPresetForm({
    ...currentFilterPreset(),
    id: document.getElementById("filter-preset-id").value,
    name: document.getElementById("filter-preset-name").value.trim() || defaultFilterPresetName(filterOptionsFromTab()),
    description: document.getElementById("filter-preset-description").value.trim(),
    options: filterOptionsFromTab()
  });
}

function applyFilterOptionsToPane(paneName, options = {}) {
  if (!isPaneName(paneName)) {
    return;
  }
  const normalized = normalizeFilterPresetOptions(options);
  const tab = tabOf(paneName);
  tab.filter = normalized.filter;
  tab.kindFilter = normalized.kindFilter;
  tab.labelFilter = normalized.labelFilter;
  renderPane(paneName);
  updateSelectionReadout();
  scheduleStateSave();
  setStatus(`${paneName}: ${filterPresetLabel(normalized)}`);
}

async function applyActiveFilterPreset() {
  const preset = currentFilterPreset();
  if (!preset) {
    return showToast("Create a filter preset first");
  }
  applyFilterOptionsToPane(app.activePane, preset.options);
  fillFilterPresetForm(preset);
  showToast(`Applied ${preset.name}`);
}

function clearPaneFilters(paneName = app.activePane) {
  applyFilterOptionsToPane(paneName, { filter: "", kindFilter: "all", labelFilter: "all" });
  renderFilterPresets();
  showToast("Pane filters cleared");
}

async function deleteActiveFilterPreset() {
  const preset = currentFilterPreset();
  if (!preset) {
    return showToast("Select a filter preset first");
  }
  if (!confirm(`Delete filter preset "${preset.name}"?`)) {
    return;
  }
  app.state.filterPresets = filterPresets().filter((item) => item.id !== preset.id);
  app.activeFilterPresetId = app.state.filterPresets[0]?.id || null;
  await saveStateNow();
  renderFilterPresets();
  renderBackupDialog();
  showToast("Filter preset deleted");
}

function newFilterPreset() {
  app.activeFilterPresetId = null;
  fillFilterPresetForm();
}

async function openFilterPresetsDialog(paneName = app.activePane) {
  app.activePane = paneName;
  await loadState();
  renderFilterPresets();
  document.getElementById("filters-dialog").showModal();
  document.getElementById("filter-preset-name").focus();
}

function cycleViewMode(paneName) {
  const modes = ["details", "compact", "tiles"];
  const tab = tabOf(paneName);
  const next = modes[(modes.indexOf(tab.viewMode) + 1) % modes.length] || "details";
  setViewMode(paneName, next);
}

function openSearchDialog() {
  document.getElementById("search-root").value = tabOf(app.activePane).path;
  document.getElementById("search-name").value = "";
  document.getElementById("search-content").value = "";
  document.getElementById("search-kind").value = "all";
  document.getElementById("search-size-op").value = "any";
  document.getElementById("search-size-value").value = "";
  document.getElementById("search-date-field").value = "modified";
  document.getElementById("search-date-op").value = "any";
  document.getElementById("search-date-days").value = "";
  document.getElementById("search-attribute").value = "any";
  document.getElementById("search-limit").value = "200";
  document.getElementById("search-max-scan").value = "8000";
  document.getElementById("search-max-kb").value = "512";
  document.getElementById("search-hidden").checked = false;
  document.getElementById("search-background-cache").checked = (app.state?.backgroundIndexes || []).some(
    (root) => root.enabled !== false
  );
  document.getElementById("search-summary").textContent = "Ready";
  document.getElementById("search-results").innerHTML = "";
  renderSearchPresets();
  document.getElementById("search-dialog").showModal();
  document.getElementById("search-name").focus();
}

function searchOptionsFromForm() {
  return {
    path: document.getElementById("search-root").value,
    query: document.getElementById("search-name").value,
    content: document.getElementById("search-content").value,
    kind: document.getElementById("search-kind").value,
    sizeOp: document.getElementById("search-size-op").value,
    sizeValue: document.getElementById("search-size-value").value,
    dateField: document.getElementById("search-date-field").value,
    dateOp: document.getElementById("search-date-op").value,
    dateDays: document.getElementById("search-date-days").value,
    attribute: document.getElementById("search-attribute").value,
    limit: Number(document.getElementById("search-limit").value || 200),
    maxScanned: Number(document.getElementById("search-max-scan").value || 8000),
    maxContentBytes: Number(document.getElementById("search-max-kb").value || 512) * 1024,
    includeHidden: document.getElementById("search-hidden").checked,
    backgroundCache: document.getElementById("search-background-cache").checked
  };
}

function searchCriteriaValidation(options) {
  if (options.sizeOp !== "any") {
    const sizeBytes = parseSelectSizeValue(options.sizeValue);
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
      return { valid: false, message: "Enter a valid search size" };
    }
    options.sizeBytes = sizeBytes;
  }
  if (options.dateOp !== "any") {
    const dayCount = Number(options.dateDays);
    if (!Number.isFinite(dayCount) || dayCount < 0) {
      return { valid: false, message: "Enter a valid search day count" };
    }
    options.dateDays = dayCount;
  }
  return { valid: true, message: "" };
}

function searchCriteriaLabel(options) {
  const parts = [];
  if (options.query) parts.push(options.query);
  if (options.content) parts.push(`content:${options.content}`);
  if (options.kind && options.kind !== "all") parts.push(options.kind);
  if (options.sizeOp && options.sizeOp !== "any") parts.push(`${options.sizeOp} ${options.sizeValue}`);
  if (options.dateOp && options.dateOp !== "any") {
    parts.push(`${options.dateField || "modified"} ${options.dateOp} ${options.dateDays}d`);
  }
  if (options.attribute && options.attribute !== "any") parts.push(`attr:${options.attribute}`);
  if (options.backgroundCache) parts.push("warm-cache");
  return parts.join(" / ") || "*";
}

function searchPresets() {
  if (!app.state) {
    return [];
  }
  if (!Array.isArray(app.state.searchPresets)) {
    app.state.searchPresets = [];
  }
  return app.state.searchPresets;
}

function currentSearchPreset() {
  const presets = searchPresets();
  return presets.find((preset) => preset.id === app.activeSearchPresetId) || presets[0] || null;
}

function defaultSearchPresetName(options = searchOptionsFromForm()) {
  const label = searchCriteriaLabel(options);
  return label === "*" ? `${labelForPath(options.path)} Search` : label.slice(0, 80);
}

function normalizedSearchPresetOptions(options = {}) {
  return {
    path: options.path || tabOf(app.activePane).path,
    query: options.query || "",
    content: options.content || "",
    kind: options.kind || "all",
    sizeOp: options.sizeOp || "any",
    sizeValue: options.sizeValue || "",
    dateField: options.dateField === "created" ? "created" : "modified",
    dateOp: options.dateOp || "any",
    dateDays: options.dateDays || "",
    attribute: options.attribute || "any",
    limit: Number(options.limit || 200),
    maxScanned: Number(options.maxScanned || 8000),
    maxContentBytes: Number(options.maxContentBytes || 512 * 1024),
    includeHidden: Boolean(options.includeHidden),
    backgroundCache: Boolean(options.backgroundCache)
  };
}

function applySearchOptionsToForm(options = {}) {
  const normalized = normalizedSearchPresetOptions(options);
  document.getElementById("search-root").value = normalized.path;
  document.getElementById("search-name").value = normalized.query;
  document.getElementById("search-content").value = normalized.content;
  document.getElementById("search-kind").value = normalized.kind;
  document.getElementById("search-size-op").value = normalized.sizeOp;
  document.getElementById("search-size-value").value = normalized.sizeValue;
  document.getElementById("search-date-field").value = normalized.dateField;
  document.getElementById("search-date-op").value = normalized.dateOp;
  document.getElementById("search-date-days").value = normalized.dateDays;
  document.getElementById("search-attribute").value = normalized.attribute;
  document.getElementById("search-limit").value = normalized.limit;
  document.getElementById("search-max-scan").value = normalized.maxScanned;
  document.getElementById("search-max-kb").value = Math.max(1, Math.round(normalized.maxContentBytes / 1024));
  document.getElementById("search-hidden").checked = normalized.includeHidden;
  document.getElementById("search-background-cache").checked = normalized.backgroundCache;
}

function searchPresetDetail(preset) {
  if (!preset?.options) {
    return "";
  }
  const options = normalizedSearchPresetOptions(preset.options);
  return `${labelForPath(options.path)} / ${searchCriteriaLabel(options)}`;
}

function renderSearchPresets() {
  const select = document.getElementById("search-preset-select");
  if (!select) {
    return;
  }
  const presets = searchPresets();
  if ((!app.activeSearchPresetId || !presets.some((preset) => preset.id === app.activeSearchPresetId)) && presets[0]) {
    app.activeSearchPresetId = presets[0].id;
  }
  const active = currentSearchPreset();
  select.innerHTML = presets.length
    ? presets
        .map(
          (preset) =>
            `<option value="${escapeHtml(preset.id)}" ${preset.id === active?.id ? "selected" : ""}>${escapeHtml(
              preset.name
            )}</option>`
        )
        .join("")
    : `<option value="">No saved searches</option>`;
  document.getElementById("search-preset-name").value = active?.name || "";
  document.getElementById("search-preset-summary").textContent = active
    ? searchPresetDetail(active)
    : `${presets.length} presets`;
}

async function saveSearchPresetFromForm(replaceActive = false) {
  if (!app.state) {
    await loadState();
  }
  const options = searchOptionsFromForm();
  const validation = searchCriteriaValidation(options);
  if (!validation.valid) {
    showToast(validation.message);
    return null;
  }
  const existing = replaceActive ? currentSearchPreset() : null;
  if (replaceActive && !existing) {
    showToast("Select a search preset first");
    return null;
  }
  const name =
    document.getElementById("search-preset-name").value.trim() ||
    existing?.name ||
    defaultSearchPresetName(options);
  const saved = {
    ...existing,
    id: existing?.id || crypto.randomUUID(),
    name,
    updatedAt: new Date().toISOString(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    options: normalizedSearchPresetOptions(options)
  };
  app.state.searchPresets = [
    saved,
    ...searchPresets().filter((preset) => preset.id !== saved.id)
  ].slice(0, 50);
  app.activeSearchPresetId = saved.id;
  await saveStateNow();
  renderSearchPresets();
  renderBackupDialog();
  showToast(replaceActive ? "Search preset replaced" : "Search preset saved");
  return saved;
}

function applyActiveSearchPreset() {
  const preset = currentSearchPreset();
  if (!preset) {
    return showToast("Save a search preset first");
  }
  applySearchOptionsToForm(preset.options);
  document.getElementById("search-preset-name").value = preset.name;
  document.getElementById("search-summary").textContent = `Preset: ${preset.name}`;
  showToast(`Applied ${preset.name}`);
}

async function deleteActiveSearchPreset() {
  const preset = currentSearchPreset();
  if (!preset) {
    return showToast("Select a search preset first");
  }
  if (!confirm(`Delete search preset "${preset.name}"?`)) {
    return;
  }
  app.state.searchPresets = searchPresets().filter((item) => item.id !== preset.id);
  app.activeSearchPresetId = app.state.searchPresets[0]?.id || null;
  await saveStateNow();
  renderSearchPresets();
  renderBackupDialog();
  showToast("Search preset deleted");
}

function renderSearchResults(result) {
  const summary = [
    result.source ? result.source : "",
    Number.isFinite(Number(result.timing?.searchMs)) ? formatMilliseconds(result.timing.searchMs) : "",
    `${result.entries.length} matches`,
    `${result.scanned} scanned`,
    result.criteriaSummary ? result.criteriaSummary : "",
    result.content && !String(result.source || "").startsWith("Warm cache") ? `${result.contentScanned} content reads` : "",
    result.contentHits ? `${result.contentHits} content hits` : "",
    result.truncated ? "truncated" : ""
  ]
    .filter(Boolean)
    .join(" / ");
  document.getElementById("search-summary").textContent = summary;
  const rows = document.getElementById("search-results");
  rows.innerHTML = result.entries.length
    ? result.entries
        .map(
          (entry) =>
            `<button class="search-result-row" data-search-path="${escapeHtml(entry.path)}">
              <span>
                <strong>${escapeHtml(entry.name)}</strong>
                <small title="${escapeHtml(entry.parent || "")}">${escapeHtml(entry.parent || "")}</small>
                ${
                  entry.matchSnippet
                    ? `<small class="search-result-snippet">${escapeHtml(entry.matchSnippet)}</small>`
                    : ""
                }
              </span>
              <span>${escapeHtml(entry.kind || "")}</span>
              <span>${formatSize(entry.size)}</span>
              <span>${formatDate(entry.modified)}</span>
            </button>`
        )
        .join("")
    : `<div class="empty-state">No matches</div>`;
}

function backgroundSearchQueryFromOptions(options) {
  return [options.query, options.content]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(" ");
}

function backgroundSearchParams(options) {
  const params = new URLSearchParams({
    q: backgroundSearchQueryFromOptions(options),
    path: options.path || "",
    kind: options.kind || "all",
    limit: String(options.limit || 200),
    includeHidden: options.includeHidden ? "1" : "0"
  });
  if (options.sizeOp && options.sizeOp !== "any") {
    params.set("sizeOp", options.sizeOp);
    params.set("sizeValue", options.sizeValue || "");
    if (Number.isFinite(Number(options.sizeBytes))) {
      params.set("sizeBytes", String(options.sizeBytes));
    }
  }
  if (options.dateOp && options.dateOp !== "any") {
    params.set("dateField", options.dateField || "modified");
    params.set("dateOp", options.dateOp);
    params.set("dateDays", String(options.dateDays || ""));
  }
  if (options.attribute && options.attribute !== "any") {
    params.set("attribute", options.attribute);
  }
  return params;
}

function normalizeBackgroundSearchEntry(entry) {
  return {
    ...entry,
    name: entry.name || labelForPath(entry.path),
    parent: entry.parent || entry.folderPath || entry.rootPath || "",
    attributeText: entry.attributeText || "",
    matchSnippet:
      entry.matchSnippet ||
      (entry.matchSource === "metadata" && entry.labelNotes ? entry.labelNotes : "")
  };
}

function backgroundSearchResultFromResponse(response, options) {
  const entries = (response.results || []).map(normalizeBackgroundSearchEntry);
  const contentHits = entries.filter((entry) => entry.matchSource === "content").length;
  const pieces = [
    "Warm cache",
    response.indexed ? `${response.stores || 0}/${response.roots || 0} root stores` : "no indexed root",
    response.freshness?.stale ? `${response.freshness.staleRoots || 0} stale root(s)` : "",
    response.criteriaSummary || ""
  ].filter(Boolean);
  return {
    root: response.root || options.path,
    query: options.query || "",
    content: options.content || "",
    kind: options.kind || "all",
    source: response.indexed ? "Warm cache" : "Warm cache (no index)",
    scanned: response.timing?.scanned || 0,
    contentScanned: 0,
    contentHits,
    limit: options.limit || 200,
    maxScanned: response.timing?.scanned || 0,
    criteria: response.criteria || null,
    criteriaSummary: pieces.join(" / "),
    truncated: response.truncated === true,
    skipped: [],
    entries,
    timing: response.timing || null,
    freshness: response.freshness || null,
    virtualMode: "background-search",
    indexed: response.indexed === true,
    stores: response.stores || 0
  };
}

function applySearchResultToPane(paneName, result, label) {
  const tab = tabOf(paneName);
  tab.entries = result.entries;
  tab.selected = new Set();
  tab.focusedPath = null;
  tab.anchorPath = null;
  tab.searchMode = true;
  tab.virtualMode = result.virtualMode || "";
  tab.virtual = null;
  tab.title = `Search: ${label}`;
  tab.parent = null;
  renderPane(paneName);
  renderInspector();
  renderSearchResults(result);
}

async function runBackgroundSearch(options, label, paneName) {
  const response = await request(`/api/background-indexes/search?${backgroundSearchParams(options).toString()}`);
  const result = backgroundSearchResultFromResponse(response, options);
  applySearchResultToPane(paneName, result, label);
  if (!result.indexed) {
    setStatus("No warm search index for this root");
    showToast("No warm search index for this root");
    return;
  }
  if (result.freshness?.stale) {
    const autoRepairing = Number(result.freshness.autoRebuilds || 0) + Number(result.freshness.activeRebuilds || 0) > 0;
    setStatus(`${result.entries.length} warm-cache matches / cache stale${autoRepairing ? " / repair running" : ""}`);
    showToast(autoRepairing ? "Warm cache is stale; rebuilding in the background" : "Warm cache may be stale");
    return;
  }
  const timing = Number.isFinite(Number(result.timing?.searchMs)) ? ` in ${formatMilliseconds(result.timing.searchMs)}` : "";
  setStatus(`${result.entries.length} warm-cache matches${timing}`);
}

async function runAdvancedSearch() {
  const paneName = app.activePane;
  const options = searchOptionsFromForm();
  const validation = searchCriteriaValidation(options);
  if (!validation.valid) {
    document.getElementById("search-summary").textContent = validation.message;
    showToast(validation.message);
    return;
  }
  const label = searchCriteriaLabel(options);
  setStatus(`Searching ${label}`);
  if (options.backgroundCache) {
    await runBackgroundSearch(options, label, paneName);
    return;
  }
  const result = await request("/api/search", {
    method: "POST",
    body: JSON.stringify(options)
  });
  applySearchResultToPane(paneName, result, label);
  setStatus(`${result.entries.length} matches`);
}

async function deepSearch() {
  openSearchDialog();
}

function openFlatDialog() {
  document.getElementById("flat-root").value = tabOf(app.activePane).path;
  document.getElementById("flat-mode").value = "files";
  document.getElementById("flat-limit").value = "1000";
  document.getElementById("flat-max-scan").value = "20000";
  document.getElementById("flat-hidden").checked = false;
  document.getElementById("flat-ignored").checked = false;
  document.getElementById("flat-summary").textContent = "Ready";
  document.getElementById("flat-results").innerHTML = "";
  document.getElementById("flat-dialog").showModal();
  document.getElementById("flat-root").focus();
}

function flatOptionsFromForm() {
  return {
    path: document.getElementById("flat-root").value,
    mode: document.getElementById("flat-mode").value,
    limit: Number(document.getElementById("flat-limit").value || 1000),
    maxScanned: Number(document.getElementById("flat-max-scan").value || 20000),
    includeHidden: document.getElementById("flat-hidden").checked,
    includeIgnored: document.getElementById("flat-ignored").checked
  };
}

function renderFlatResults(result) {
  const skipped = result.skipped?.length ? `${result.skipped.length} skipped` : "";
  const summary = [
    `${result.entries.length} items`,
    `${result.scanned} scanned`,
    skipped,
    result.truncated ? "truncated" : ""
  ]
    .filter(Boolean)
    .join(" / ");
  document.getElementById("flat-summary").textContent = summary;
  const rows = document.getElementById("flat-results");
  rows.innerHTML = result.entries.length
    ? result.entries
        .map(
          (entry) =>
            `<button class="search-result-row" data-search-path="${escapeHtml(entry.path)}">
              <span>
                <strong>${escapeHtml(entry.name)}</strong>
                <small title="${escapeHtml(entry.parent || "")}">${escapeHtml(entry.parent || "")}</small>
              </span>
              <span>${escapeHtml(entry.kind || "")}</span>
              <span>${formatSize(entry.size)}</span>
              <span>${formatDate(entry.modified)}</span>
            </button>`
        )
        .join("")
    : `<div class="empty-state">No items</div>`;
}

async function runFlatView() {
  const paneName = app.activePane;
  const options = flatOptionsFromForm();
  setStatus(`Flattening ${labelForPath(options.path)}`);
  document.getElementById("flat-summary").textContent = "Scanning...";
  const result = await request("/api/flat", {
    method: "POST",
    body: JSON.stringify(options)
  });
  const tab = tabOf(paneName);
  tab.path = result.root;
  tab.entries = result.entries;
  tab.selected = new Set();
  tab.focusedPath = null;
  tab.anchorPath = null;
  tab.searchMode = true;
  tab.virtualMode = "";
  tab.virtual = null;
  tab.title = `Flat: ${labelForPath(result.root)}`;
  tab.parent = null;
  renderPane(paneName);
  renderRoots();
  renderInspector();
  renderFlatResults(result);
  setStatus(`${result.entries.length} flat items`);
}

function openDuplicatesDialog() {
  app.duplicateResult = null;
  document.getElementById("duplicates-root").value = tabOf(app.activePane).path;
  document.getElementById("duplicates-mode").value = "hash";
  document.getElementById("duplicates-recursive").checked = true;
  document.getElementById("duplicates-hidden").checked = false;
  document.getElementById("duplicates-ignored").checked = false;
  document.getElementById("duplicates-max-scan").value = "20000";
  document.getElementById("duplicates-max-hash").value = "128";
  document.getElementById("duplicates-summary").textContent = "Ready";
  document.getElementById("duplicates-results").innerHTML = "";
  document.getElementById("duplicates-dialog").showModal();
  document.getElementById("duplicates-root").focus();
}

function duplicatesOptionsFromForm() {
  return {
    path: document.getElementById("duplicates-root").value,
    mode: document.getElementById("duplicates-mode").value,
    recursive: document.getElementById("duplicates-recursive").checked,
    includeHidden: document.getElementById("duplicates-hidden").checked,
    includeIgnored: document.getElementById("duplicates-ignored").checked,
    maxEntries: Number(document.getElementById("duplicates-max-scan").value || 20000),
    maxHashBytes: Number(document.getElementById("duplicates-max-hash").value || 128) * 1024 * 1024
  };
}

function duplicateSummaryText(result) {
  const skipped = result.skipped?.length ? `${result.skipped.length} skipped` : "";
  const hashScanned = result.mode === "hash" ? `${result.hashScanned} hashed` : "size match";
  return [
    `${result.groupCount} groups`,
    `${result.duplicateFiles} files`,
    `${formatSize(result.wastedBytes)} reclaimable`,
    `${result.scanned} scanned`,
    hashScanned,
    skipped,
    result.truncated ? "truncated" : ""
  ]
    .filter(Boolean)
    .join(" / ");
}

function duplicateGroupKeyText(group, mode) {
  if (mode === "hash" && group.hash) {
    return `SHA-256 ${group.hash.slice(0, 16)}`;
  }
  return `${formatSize(group.size)} exact size`;
}

function renderDuplicateResults(result) {
  app.duplicateResult = result;
  document.getElementById("duplicates-summary").textContent = duplicateSummaryText(result);
  const rows = document.getElementById("duplicates-results");
  rows.innerHTML = result.groups.length
    ? result.groups
        .map(
          (group) =>
            `<section class="duplicate-group">
              <div class="duplicate-group-head">
                <span>Group ${group.index}</span>
                <strong>${group.count} files</strong>
                <span>${formatSize(group.size)} each</span>
                <span>${formatSize(group.wastedBytes)} reclaimable</span>
                <code title="${escapeHtml(group.key)}">${escapeHtml(duplicateGroupKeyText(group, result.mode))}</code>
              </div>
              <div class="duplicate-items">
                ${group.items
                  .map(
                    (entry) =>
                      `<button class="duplicate-item-row" data-search-path="${escapeHtml(entry.path)}">
                        <span>
                          <strong>${escapeHtml(entry.name)}</strong>
                          <small title="${escapeHtml(entry.parent || "")}">${escapeHtml(entry.parent || "")}</small>
                        </span>
                        <span>${formatSize(entry.size)}</span>
                        <span>${formatDate(entry.modified)}</span>
                      </button>`
                  )
                  .join("")}
              </div>
            </section>`
        )
        .join("")
    : `<div class="empty-state">No duplicates</div>`;
}

function openDuplicateResultsInPane(result, paneName = app.activePane) {
  const tab = tabOf(paneName);
  tab.path = result.root;
  tab.entries = result.entries;
  tab.selected = new Set();
  tab.focusedPath = null;
  tab.anchorPath = null;
  tab.columns = normalizeColumns(["name", "size", "modified", "parent"]);
  tab.sortKey = "size";
  tab.sortDir = "desc";
  tab.searchMode = true;
  tab.virtualMode = "";
  tab.virtual = null;
  tab.title = `Dupes: ${labelForPath(result.root)}`;
  tab.parent = null;
  renderPane(paneName);
  renderRoots();
  renderInspector();
}

async function runDuplicateScan() {
  const paneName = app.activePane;
  const options = duplicatesOptionsFromForm();
  setStatus(`Scanning duplicates in ${labelForPath(options.path)}`);
  document.getElementById("duplicates-summary").textContent = "Scanning...";
  const result = await request("/api/duplicates", {
    method: "POST",
    body: JSON.stringify(options)
  });
  openDuplicateResultsInPane(result, paneName);
  renderDuplicateResults(result);
  setStatus(`${result.groupCount} duplicate groups`);
}

async function openCompareDialog() {
  if (!app.state) {
    await loadState();
  }
  applySyncProfileOptionsToForm({
    leftPath: tabOf("left").path,
    rightPath: tabOf("right").path,
    recursive: true,
    includeHidden: false,
    maxEntries: 20000,
    overwrite: true,
    mirrorDeletes: false
  });
  invalidateCompareResult("Ready");
  renderSyncProfiles();
  document.getElementById("compare-dialog").showModal();
}

function compareOptionsFromForm() {
  return {
    leftPath: document.getElementById("compare-left").value,
    rightPath: document.getElementById("compare-right").value,
    recursive: document.getElementById("compare-recursive").checked,
    includeHidden: document.getElementById("compare-hidden").checked,
    maxEntries: Number(document.getElementById("compare-max").value || 20000)
  };
}

function normalizedSyncProfileOptions(options = {}) {
  const maxEntries = Number(options.maxEntries || 20000);
  return {
    leftPath: options.leftPath || tabOf("left").path,
    rightPath: options.rightPath || tabOf("right").path,
    recursive: options.recursive !== false,
    includeHidden: Boolean(options.includeHidden),
    maxEntries: Number.isFinite(maxEntries) ? Math.max(100, Math.min(maxEntries, 100000)) : 20000,
    overwrite: options.overwrite !== false,
    mirrorDeletes: Boolean(options.mirrorDeletes)
  };
}

function syncProfileOptionsFromForm() {
  return normalizedSyncProfileOptions({
    ...compareOptionsFromForm(),
    overwrite: document.getElementById("compare-overwrite").checked,
    mirrorDeletes: document.getElementById("compare-mirror-deletes").checked
  });
}

function applySyncProfileOptionsToForm(options = {}) {
  const normalized = normalizedSyncProfileOptions(options);
  document.getElementById("compare-left").value = normalized.leftPath;
  document.getElementById("compare-right").value = normalized.rightPath;
  document.getElementById("compare-recursive").checked = normalized.recursive;
  document.getElementById("compare-hidden").checked = normalized.includeHidden;
  document.getElementById("compare-max").value = normalized.maxEntries;
  document.getElementById("compare-overwrite").checked = normalized.overwrite;
  document.getElementById("compare-mirror-deletes").checked = normalized.mirrorDeletes;
}

function invalidateCompareResult(message = "Ready") {
  app.compareResult = null;
  app.compareSyncPreview = null;
  const summary = document.getElementById("compare-summary");
  if (summary) {
    summary.textContent = message;
  }
  const syncPreview = document.getElementById("sync-preview");
  if (syncPreview) {
    syncPreview.innerHTML = "";
  }
  const applySync = document.getElementById("compare-sync-apply");
  if (applySync) {
    applySync.disabled = true;
  }
  const results = document.getElementById("compare-results");
  if (results) {
    results.innerHTML = "";
  }
}

function syncProfiles() {
  if (!app.state) {
    return [];
  }
  if (!Array.isArray(app.state.syncProfiles)) {
    app.state.syncProfiles = [];
  }
  return app.state.syncProfiles;
}

function currentSyncProfile() {
  const profiles = syncProfiles();
  return profiles.find((profile) => profile.id === app.activeSyncProfileId) || profiles[0] || null;
}

function defaultSyncProfileName(options = syncProfileOptionsFromForm()) {
  return `${labelForPath(options.leftPath)} -> ${labelForPath(options.rightPath)}`.slice(0, 80);
}

function syncProfileDetail(profile) {
  if (!profile?.options) {
    return "";
  }
  const options = normalizedSyncProfileOptions(profile.options);
  const flags = [
    options.recursive ? "recursive" : "top-level",
    options.includeHidden ? "hidden" : "",
    options.overwrite ? "overwrite" : "no overwrite",
    options.mirrorDeletes ? "mirror extras" : ""
  ].filter(Boolean);
  return `${labelForPath(options.leftPath)} -> ${labelForPath(options.rightPath)} / ${flags.join(" / ")}`;
}

function renderSyncProfiles() {
  const select = document.getElementById("sync-profile-select");
  if (!select) {
    return;
  }
  const profiles = syncProfiles();
  if ((!app.activeSyncProfileId || !profiles.some((profile) => profile.id === app.activeSyncProfileId)) && profiles[0]) {
    app.activeSyncProfileId = profiles[0].id;
  }
  const active = currentSyncProfile();
  select.innerHTML = profiles.length
    ? profiles
        .map(
          (profile) =>
            `<option value="${escapeHtml(profile.id)}" ${profile.id === active?.id ? "selected" : ""}>${escapeHtml(
              profile.name
            )}</option>`
        )
        .join("")
    : `<option value="">No sync profiles</option>`;
  document.getElementById("sync-profile-name").value = active?.name || "";
  document.getElementById("sync-profile-summary").textContent = active
    ? syncProfileDetail(active)
    : `${profiles.length} profiles`;
}

async function saveSyncProfileFromForm(replaceActive = false) {
  if (!app.state) {
    await loadState();
  }
  const existing = replaceActive ? currentSyncProfile() : null;
  if (replaceActive && !existing) {
    return showToast("Select a sync profile first");
  }
  const options = syncProfileOptionsFromForm();
  if (!options.leftPath || !options.rightPath) {
    return showToast("Choose both compare folders first");
  }
  const now = new Date().toISOString();
  const saved = {
    ...existing,
    id: existing?.id || crypto.randomUUID(),
    name: document.getElementById("sync-profile-name").value.trim() || existing?.name || defaultSyncProfileName(options),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    options
  };
  app.state.syncProfiles = [
    saved,
    ...syncProfiles().filter((profile) => profile.id !== saved.id)
  ].slice(0, 50);
  app.activeSyncProfileId = saved.id;
  await saveStateNow();
  renderSyncProfiles();
  renderBackupDialog();
  showToast(replaceActive ? "Sync profile replaced" : "Sync profile saved");
  return saved;
}

function applyActiveSyncProfile() {
  const profile = currentSyncProfile();
  if (!profile) {
    return showToast("Save a sync profile first");
  }
  applySyncProfileOptionsToForm(profile.options);
  document.getElementById("sync-profile-name").value = profile.name;
  invalidateCompareResult(`Profile: ${profile.name}`);
  showToast(`Loaded ${profile.name}`);
}

async function deleteActiveSyncProfile() {
  const profile = currentSyncProfile();
  if (!profile) {
    return showToast("Select a sync profile first");
  }
  if (!confirm(`Delete sync profile "${profile.name}"?`)) {
    return;
  }
  app.state.syncProfiles = syncProfiles().filter((item) => item.id !== profile.id);
  app.activeSyncProfileId = app.state.syncProfiles[0]?.id || null;
  await saveStateNow();
  renderSyncProfiles();
  renderBackupDialog();
  showToast("Sync profile deleted");
}

function compareCountsText(counts = {}) {
  const parts = ["leftOnly", "rightOnly", "newerLeft", "newerRight", "different", "typeMismatch"]
    .map((key) => (counts[key] ? `${key}: ${counts[key]}` : ""))
    .filter(Boolean);
  return parts.length ? parts.join(" / ") : "no differences";
}

function shouldPreselectCompare(row) {
  return ["leftOnly", "newerLeft", "different"].includes(row.status);
}

function renderCompareResults(result) {
  app.compareResult = result;
  app.compareSyncPreview = null;
  const syncPreview = document.getElementById("sync-preview");
  if (syncPreview) {
    syncPreview.innerHTML = "";
  }
  const applySync = document.getElementById("compare-sync-apply");
  if (applySync) {
    applySync.disabled = true;
  }
  document.getElementById("compare-summary").textContent = `${result.entries.length} shown / ${compareCountsText(
    result.counts
  )}${result.truncated ? " / truncated" : ""}`;
  const results = document.getElementById("compare-results");
  results.innerHTML = result.entries.length
    ? result.entries
        .map(
          (row) =>
            `<div class="compare-row" data-compare-relative="${escapeHtml(row.relative)}">
              <input type="checkbox" data-compare-select="${escapeHtml(row.relative)}" ${
                shouldPreselectCompare(row) ? "checked" : ""
              } />
              <span>
                <strong title="${escapeHtml(row.relative)}">${escapeHtml(row.relative)}</strong>
                <small>${escapeHtml(row.kind || "")}</small>
              </span>
              <span><span class="compare-status ${escapeHtml(row.status)}">${escapeHtml(
                row.status
              )}</span></span>
              <span>${formatSize(row.sizeLeft)}</span>
              <span>${formatSize(row.sizeRight)}</span>
              <span>${formatDate(row.modifiedLeft)}</span>
              <span>${formatDate(row.modifiedRight)}</span>
            </div>`
        )
        .join("")
    : `<div class="empty-state">No differences</div>`;
}

async function runCompare() {
  setStatus("Comparing panes");
  const result = await request("/api/compare", {
    method: "POST",
    body: JSON.stringify(compareOptionsFromForm())
  });
  renderCompareResults(result);
  setStatus(`${result.entries.length} compare rows`);
}

function selectedCompareItems() {
  return [...document.querySelectorAll("[data-compare-select]:checked")].map(
    (input) => input.dataset.compareSelect
  );
}

function syncPreviewCountsText(actionCounts = {}) {
  const parts = ["copy", "overwrite", "mirror-delete", "skip", "missing-source", "risky"]
    .map((key) => (actionCounts[key] ? `${key}: ${actionCounts[key]}` : ""))
    .filter(Boolean);
  return parts.length ? parts.join(" / ") : "no changes";
}

function syncPayload(direction, options = {}) {
  const payload = {
    leftPath: document.getElementById("compare-left").value,
    rightPath: document.getElementById("compare-right").value,
    direction,
    overwrite: document.getElementById("compare-overwrite").checked,
    mirrorDeletes: document.getElementById("compare-mirror-deletes").checked,
    items: selectedCompareItems()
  };
  if (options.expectedPlanDigest) {
    payload.expectedPlanDigest = options.expectedPlanDigest;
  }
  if (options.applyToken) {
    payload.applyToken = options.applyToken;
  }
  return payload;
}

function renderSyncPreview(plan, payload) {
  app.compareSyncPreview = { plan, payload };
  const applySync = document.getElementById("compare-sync-apply");
  if (applySync) {
    applySync.disabled = !plan.canApply;
  }
  document.getElementById("compare-summary").textContent = `${plan.items.length} planned / ${plan.direction} / ${syncPreviewCountsText(
    plan.actionCounts
  )}`;
  const preview = document.getElementById("sync-preview");
  if (!preview) {
    return;
  }
  preview.innerHTML = plan.items.length
    ? `<div class="sync-preview-head">
        <strong>${escapeHtml(plan.direction === "rightToLeft" ? "Right to Left" : "Left to Right")}</strong>
        <span>${escapeHtml(syncPreviewCountsText(plan.actionCounts))}</span>
      </div>
      <div class="sync-preview-list">${plan.items
        .map(
          (item) =>
            `<div class="sync-preview-row ${escapeHtml(item.status)} ${item.risky ? "risky" : ""}">
              <span class="sync-preview-index">${item.index + 1}</span>
              <span>
                <strong title="${escapeHtml(item.relativePath)}">${escapeHtml(item.relativePath)}</strong>
                <small title="${escapeHtml(item.source)}">${escapeHtml(item.source)}</small>
              </span>
              <span>
                <strong>${escapeHtml(item.action)}</strong>
                <small title="${escapeHtml(item.dest)}">${escapeHtml(item.dest)}</small>
              </span>
              <span><span class="transfer-status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></span>
              <span>${escapeHtml(item.reason || "")}</span>
            </div>`
        )
        .join("")}</div>`
    : `<div class="empty-state">No sync work selected</div>`;
}

async function previewSyncCompare(direction) {
  if (!app.compareResult) {
    await runCompare();
  }
  const payload = syncPayload(direction);
  if (!payload.items.length) {
    return showToast("Select compare rows first");
  }
  document.getElementById("compare-summary").textContent = "Planning sync...";
  document.getElementById("compare-sync-apply").disabled = true;
  const plan = await operationPreview("sync", payload);
  renderSyncPreview(plan, payload);
  showToast("Sync plan ready");
}

async function applySyncPreview() {
  const preview = app.compareSyncPreview;
  if (!preview?.plan?.canApply || !preview?.payload?.items?.length) {
    return showToast("Plan sync first");
  }
  const result = await request("/api/sync", {
    method: "POST",
    body: JSON.stringify({
      ...preview.payload,
      expectedPlanDigest: preview.plan.planDigest,
      applyToken: preview.plan.applyToken
    })
  });
  await Promise.all([refreshPane("left"), refreshPane("right")]);
  await syncStateAndChrome();
  await runCompare();
  const deleted = result.deleted?.length || 0;
  showToast(`Synced ${result.copied?.length || 0} item(s)${deleted ? ` / mirrored ${deleted} extra(s)` : ""}`);
}

async function revealSelected() {
  const selection = selectedPaths(app.activePane);
  const target = selection[0] || tabOf(app.activePane).path;
  await request("/api/open", {
    method: "POST",
    body: JSON.stringify({ path: target, reveal: Boolean(selection[0]) })
  });
}

function entryForPath(paneName, itemPath) {
  return tabOf(paneName).entries.find((entry) => samePath(entry.path, itemPath)) || null;
}

function openWithTargetsForPaths(paneName, paths, options = {}) {
  const tab = tabOf(paneName);
  return paths.filter(Boolean).map((itemPath) => {
    const entry = entryForPath(paneName, itemPath);
    const isPaneFolder = samePath(itemPath, tab.path) || samePath(itemPath, options.folderPath);
    return {
      path: itemPath,
      name: entry?.name || labelForPath(itemPath),
      isDirectory: entry ? Boolean(entry.isDirectory) : isPaneFolder,
      kind: entry?.kind || (isPaneFolder ? "Folder" : "Path")
    };
  });
}

function openWithTargetsForPane(paneName = app.activePane) {
  const tab = tabOf(paneName);
  const selection = selectedPaths(paneName);
  const paths = selection.length ? selection : [tab.path];
  return openWithTargetsForPaths(paneName, paths, { folderPath: tab.path });
}

function renderOpenWithDialog(message = null) {
  const targets = app.openWith?.targets || [];
  const summary = document.getElementById("open-with-summary");
  if (summary) {
    summary.textContent = message || `${targets.length} target${targets.length === 1 ? "" : "s"}`;
  }
  const note = document.getElementById("open-with-target-note");
  if (note) {
    note.textContent = app.openWith?.fromSelection
      ? "Uses the active pane selection."
      : "No files selected; using the active folder.";
  }
  const list = document.getElementById("open-with-target-list");
  if (!list) {
    return;
  }
  list.innerHTML = targets.length
    ? targets
        .map(
          (target) =>
            `<div class="open-with-target-row">
              <span>${target.isDirectory ? "DIR" : "FILE"}</span>
              <strong title="${escapeHtml(target.path)}">${escapeHtml(target.name)}</strong>
              <small>${escapeHtml(target.path)}</small>
            </div>`
        )
        .join("")
    : `<div class="empty-state">No target selected</div>`;
  renderOpenWithPresets();
}

function defaultOpenWithCwd() {
  const first = app.openWith?.targets?.[0];
  if (!first) {
    return tabOf(app.activePane).path;
  }
  return first.isDirectory ? first.path : first.path.replace(/[\\/][^\\/]*$/, "") || tabOf(app.activePane).path;
}

function fillOpenWithForm({ appPath = "", args = "{path}", cwd = null } = {}) {
  document.getElementById("open-with-app").value = appPath;
  document.getElementById("open-with-args").value = args;
  document.getElementById("open-with-cwd").value = cwd || defaultOpenWithCwd();
}

function normalizeOpenWithExtensions(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[,\s;]+/);
  const extensions = [];
  for (const item of items) {
    const text = String(item || "").trim().toLowerCase();
    if (!text) {
      continue;
    }
    const normalized = text === "*" || text === "folder" || text === "folders"
      ? text
      : `.${text.replace(/^\.+/, "")}`;
    if (/^(\*|folders?|[.][a-z0-9_-]{1,24})$/.test(normalized) && !extensions.includes(normalized)) {
      extensions.push(normalized);
    }
  }
  return extensions.slice(0, 40);
}

function openWithExtensionsText(extensions = []) {
  return normalizeOpenWithExtensions(extensions).join(", ");
}

function targetExtension(target) {
  if (target?.isDirectory) {
    return "folder";
  }
  const name = target?.path || target?.name || "";
  const match = /(\.[^./\\]+)$/.exec(name);
  return match ? match[1].toLowerCase() : "";
}

function openWithPresetMatchesTargets(preset, targets = app.openWith?.targets || []) {
  const extensions = normalizeOpenWithExtensions(preset?.extensions || []);
  if (!extensions.length || extensions.includes("*")) {
    return true;
  }
  if (!targets.length) {
    return false;
  }
  return targets.some((target) => {
    const extension = targetExtension(target);
    if (target?.isDirectory && (extensions.includes("folder") || extensions.includes("folders"))) {
      return true;
    }
    return extension && extensions.includes(extension);
  });
}

function matchingOpenWithPresets(targets = app.openWith?.targets || [], limit = 8) {
  return openWithPresets().filter((preset) => openWithPresetMatchesTargets(preset, targets)).slice(0, limit);
}

function openWithPresets() {
  if (!app.state) {
    return [];
  }
  if (!Array.isArray(app.state.openWithPresets)) {
    app.state.openWithPresets = [];
  }
  return app.state.openWithPresets;
}

function currentOpenWithPreset() {
  const presets = openWithPresets();
  return presets.find((preset) => preset.id === app.activeOpenWithPresetId) || presets[0] || null;
}

function defaultOpenWithPresetName(appPath = document.getElementById("open-with-app")?.value || "") {
  const label = String(appPath || "").split(/[\\/]/).filter(Boolean).pop() || "Open With Preset";
  return label.replace(/\.(exe|cmd|bat|ps1)$/i, "").slice(0, 80) || "Open With Preset";
}

function openWithPresetFromForm(existing = null) {
  const appPath = document.getElementById("open-with-app").value.trim();
  const argsTemplate = document.getElementById("open-with-args").value.trim() || "{path}";
  const workingDirectory = document.getElementById("open-with-cwd").value.trim();
  const extensions = normalizeOpenWithExtensions(document.getElementById("open-with-extensions").value);
  const name = document.getElementById("open-with-preset-name").value.trim() ||
    existing?.name ||
    defaultOpenWithPresetName(appPath);
  return {
    ...existing,
    id: existing?.id || "",
    name,
    appPath,
    argsTemplate,
    workingDirectory,
    extensions
  };
}

function openWithPresetDetail(preset) {
  if (!preset) {
    return "";
  }
  const args = preset.argsTemplate || "{path}";
  const cwd = preset.workingDirectory ? ` / cwd ${preset.workingDirectory}` : "";
  const extensions = openWithExtensionsText(preset.extensions);
  return `${preset.appPath || "No app"} ${args}${cwd}${extensions ? ` / ${extensions}` : ""}`;
}

function renderOpenWithPresets() {
  const select = document.getElementById("open-with-preset-select");
  if (!select) {
    return;
  }
  const presets = openWithPresets();
  if ((!app.activeOpenWithPresetId || !presets.some((preset) => preset.id === app.activeOpenWithPresetId)) && presets[0]) {
    app.activeOpenWithPresetId = presets[0].id;
  }
  const active = currentOpenWithPreset();
  select.innerHTML = presets.length
    ? presets
        .map(
          (preset) =>
            `<option value="${escapeHtml(preset.id)}" ${preset.id === active?.id ? "selected" : ""}>${escapeHtml(
              preset.name
            )}</option>`
        )
        .join("")
    : `<option value="">No saved launchers</option>`;
  document.getElementById("open-with-preset-name").value = active?.name || "";
  document.getElementById("open-with-preset-summary").textContent = active
    ? openWithPresetDetail(active)
    : `${presets.length} presets`;
  const matched = document.getElementById("open-with-matched-presets");
  if (matched) {
    const matching = matchingOpenWithPresets();
    matched.innerHTML = matching.length
      ? matching
          .map(
            (preset) =>
              `<button type="button" data-open-with-matched-preset="${escapeHtml(preset.id)}" title="${escapeHtml(
                openWithPresetDetail(preset)
              )}">${escapeHtml(preset.name)}</button>`
          )
          .join("")
      : `<span>No matching presets</span>`;
  }
}

async function saveOpenWithPresetFromForm(replaceActive = false) {
  if (!app.state) {
    await loadState();
  }
  const existing = replaceActive ? currentOpenWithPreset() : null;
  if (replaceActive && !existing) {
    return showToast("Select an Open With preset first");
  }
  const draft = openWithPresetFromForm(existing);
  if (!draft.appPath) {
    return showToast("Enter an application first");
  }
  const now = new Date().toISOString();
  const saved = {
    ...draft,
    id: existing?.id || crypto.randomUUID(),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  app.state.openWithPresets = [
    saved,
    ...openWithPresets().filter((preset) => preset.id !== saved.id)
  ].slice(0, 50);
  app.activeOpenWithPresetId = saved.id;
  await saveStateNow();
  renderOpenWithPresets();
  renderBackupDialog();
  showToast(replaceActive ? "Open With preset replaced" : "Open With preset saved");
  return saved;
}

function applyActiveOpenWithPreset() {
  const preset = currentOpenWithPreset();
  if (!preset) {
    return showToast("Save an Open With preset first");
  }
  fillOpenWithForm({
    appPath: preset.appPath,
    args: preset.argsTemplate || "{path}",
    cwd: preset.workingDirectory || defaultOpenWithCwd()
  });
  document.getElementById("open-with-extensions").value = openWithExtensionsText(preset.extensions);
  document.getElementById("open-with-preset-name").value = preset.name;
  renderOpenWithDialog(`Preset: ${preset.name}`);
  showToast(`Loaded ${preset.name}`);
}

async function runActiveOpenWithPreset() {
  const preset = currentOpenWithPreset();
  if (!preset) {
    return showToast("Save an Open With preset first");
  }
  await runOpenWithPreset(preset);
}

async function deleteActiveOpenWithPreset() {
  const preset = currentOpenWithPreset();
  if (!preset) {
    return showToast("Select an Open With preset first");
  }
  if (!confirm(`Delete Open With preset "${preset.name}"?`)) {
    return;
  }
  app.state.openWithPresets = openWithPresets().filter((item) => item.id !== preset.id);
  app.activeOpenWithPresetId = app.state.openWithPresets[0]?.id || null;
  await saveStateNow();
  renderOpenWithPresets();
  renderBackupDialog();
  showToast("Open With preset deleted");
}

function openWithRequestBody(mode) {
  const targets = app.openWith?.targets || [];
  const body = {
    mode,
    paths: targets.map((target) => target.path)
  };
  if (mode === "custom") {
    body.appPath = document.getElementById("open-with-app").value.trim();
    body.argsTemplate = document.getElementById("open-with-args").value.trim() || "{path}";
    body.workingDirectory = document.getElementById("open-with-cwd").value.trim() || defaultOpenWithCwd();
  }
  return body;
}

function renderOpenWithResult(result, mode) {
  const launched = result?.launched || [];
  const output = document.getElementById("open-with-output");
  if (output) {
    output.textContent = launched.length
      ? launched
          .map((item) => {
            const args = item.args?.length ? ` ${item.args.join(" ")}` : "";
            return `${item.mode || mode}: ${item.path}${item.file ? `\n  ${item.file}${args}` : ""}${item.cwd ? `\n  cwd ${item.cwd}` : ""}`;
          })
          .join("\n\n")
      : "No launch result returned.";
  }
  renderOpenWithDialog(`Launched ${launched.length}`);
}

async function runOpenWith(mode) {
  const targets = app.openWith?.targets || [];
  if (!targets.length) {
    return showToast("Select something to open first");
  }
  const result = await request("/api/open-with", {
    method: "POST",
    body: JSON.stringify(openWithRequestBody(mode))
  });
  renderOpenWithResult(result, mode);
  showToast("Open With launched");
}

async function runOpenWithPreset(preset, targets = app.openWith?.targets || [], paneName = app.openWith?.paneName || app.activePane) {
  if (!preset) {
    return showToast("Save an Open With preset first");
  }
  if (!targets.length) {
    return showToast("Select something to open first");
  }
  app.activePane = paneName;
  app.activeOpenWithPresetId = preset.id;
  app.openWith = {
    paneName,
    targets,
    fromSelection: selectedPaths(paneName).length > 0
  };
  fillOpenWithForm({
    appPath: preset.appPath,
    args: preset.argsTemplate || "{path}",
    cwd: preset.workingDirectory || defaultOpenWithCwd()
  });
  document.getElementById("open-with-extensions").value = openWithExtensionsText(preset.extensions);
  document.getElementById("open-with-preset-name").value = preset.name;
  renderOpenWithDialog(`Preset: ${preset.name}`);
  await runOpenWith("custom");
}

async function runContextOpenWithPreset(paneName, presetId, targets) {
  const preset = openWithPresets().find((item) => item.id === presetId);
  if (!preset) {
    return showToast("Open With preset is no longer available");
  }
  await runOpenWithPreset(preset, targets, paneName);
}

function applyOpenWithPreset(name) {
  if (name === "notepad") {
    fillOpenWithForm({ appPath: "notepad.exe", args: "{path}" });
    document.getElementById("open-with-preset-name").value = "Notepad";
    document.getElementById("open-with-extensions").value = ".txt, .md, .json, .js, .css, .html, .log";
  }
  if (name === "code") {
    fillOpenWithForm({ appPath: "code.cmd", args: "{paths}" });
    document.getElementById("open-with-preset-name").value = "VS Code";
    document.getElementById("open-with-extensions").value = "*";
  }
  if (name === "powershell") {
    fillOpenWithForm({ appPath: "powershell.exe", args: "-NoExit -Command Set-Location -LiteralPath \"{folder}\"" });
    document.getElementById("open-with-preset-name").value = "PowerShell";
    document.getElementById("open-with-extensions").value = "folder";
  }
  document.getElementById("open-with-preset-summary").textContent = "Built-in template loaded";
}

function openOpenWithDialog(paneName = app.activePane, paths = null) {
  const targets = paths?.length
    ? openWithTargetsForPaths(paneName, paths)
    : openWithTargetsForPane(paneName);
  app.activePane = paneName;
  app.openWith = {
    paneName,
    targets,
    fromSelection: selectedPaths(paneName).length > 0
  };
  renderOpenWithDialog();
  fillOpenWithForm({ appPath: "notepad.exe", args: "{path}" });
  renderOpenWithPresets();
  document.getElementById("open-with-output").textContent =
    "Placeholders: {path}, {paths}, {folder}, {name}, {stem}";
  document.getElementById("open-with-dialog").showModal();
}

function contextEntry() {
  const menu = app.contextMenu;
  if (!menu?.entryPath) {
    return null;
  }
  return tabOf(menu.paneName).entries.find((entry) => samePath(entry.path, menu.entryPath)) || null;
}

function contextOpenWithTargets(menu = app.contextMenu) {
  const paneName = menu?.paneName || app.activePane;
  const tab = tabOf(paneName);
  const selection = selectedPaths(paneName);
  const paths = selection.length ? selection : [menu?.entryPath || tab.path];
  return openWithTargetsForPaths(paneName, paths, { folderPath: tab.path });
}

function contextMenuItem(action, label, options = {}) {
  return { action, label, ...options };
}

function contextOpenWithPresetItems(menu = app.contextMenu) {
  const targets = contextOpenWithTargets(menu);
  return matchingOpenWithPresets(targets, 5).map((preset) =>
    contextMenuItem(`open-with-preset:${preset.id}`, `Open With: ${preset.name}`)
  );
}

function columnContextMenuItems(menu = app.contextMenu) {
  const paneName = menu?.paneName || app.activePane;
  const tab = tabOf(paneName);
  const activeColumns = new Set(normalizeColumns(tab.columns));
  const column = columnDefById(menu?.columnId) || columnsForTab(tab)[0];
  const items = [];
  if (column) {
    items.push(
      contextMenuItem(`column-sort:${column.sortKey}:asc`, `Sort ${column.title} Asc`),
      contextMenuItem(`column-sort:${column.sortKey}:desc`, `Sort ${column.title} Desc`),
      contextMenuItem(`column-autosize:${column.id}`, `Autosize ${column.title}`)
    );
    if (!column.required) {
      items.push(contextMenuItem(`column-toggle:${column.id}`, `Hide ${column.title}`));
    }
  }
  items.push(contextMenuItem("column-autosize-all", "Autosize All Columns"));
  items.push({ separator: true });
  for (const hiddenColumn of detailColumnDefs.filter((item) => !activeColumns.has(item.id))) {
    items.push(contextMenuItem(`column-toggle:${hiddenColumn.id}`, `Show ${hiddenColumn.title}`));
  }
  if (items.at(-1)?.separator !== true) {
    items.push({ separator: true });
  }
  items.push(
    ...columnPresetDefinitions.map((preset) =>
      contextMenuItem(`column-preset:${preset.id}`, `Preset: ${preset.name}`)
    )
  );
  items.push({ separator: true });
  items.push(
    contextMenuItem("column-reset-default", "Reset Columns"),
    contextMenuItem("column-reset-widths", "Reset Widths"),
    contextMenuItem("column-save-format", "Save Folder Format"),
    contextMenuItem("columns", "Choose Columns")
  );
  return items;
}

function contextMenuItems(menu = app.contextMenu) {
  const paneName = menu?.paneName || app.activePane;
  if (menu?.type === "columns") {
    return columnContextMenuItems(menu);
  }
  const selectionCount = selectedPaths(paneName).length;
  const hasSelection = selectionCount > 0;
  const hasZipVirtualSelection = selectedEntries(paneName).some((item) => isZipVirtualEntry(item));
  const hasFilesystemSelection = hasSelection && !hasZipVirtualSelection;
  const entry = contextEntry();
  const items = [];

  if (entry) {
    const canOpenAsFolder = entry.isDirectory || isRealZipFileEntry(entry);
    items.push(
      contextMenuItem("open", entry.isDirectory ? "Open Folder" : "Open", { shortcut: "Enter" }),
      contextMenuItem("open-new-tab", "Open Folder In New Tab", {
        shortcut: "Ctrl+Enter",
        disabled: !canOpenAsFolder
      }),
      contextMenuItem("viewer", "Open Viewer", { shortcut: "F3", disabled: !viewerSupportsEntry(entry) }),
      contextMenuItem("open-other", "Open In Other Pane", { disabled: !canOpenAsFolder }),
      contextMenuItem("open-with", "Open With"),
      ...contextOpenWithPresetItems(menu),
      contextMenuItem("shell-verbs", "Shell Verbs", { disabled: hasZipVirtualSelection }),
      contextMenuItem("reveal", "Reveal In Explorer")
    );
    items.push({ separator: true });
    items.push(
      contextMenuItem("copy-clip", `Copy ${selectionCount || 1} Item(s)`, {
        shortcut: "Ctrl+C",
        disabled: hasZipVirtualSelection
      }),
      contextMenuItem("copy-names", "Copy Names"),
      contextMenuItem("checksums", "Create Checksums", { disabled: !hasFilesystemSelection }),
      contextMenuItem("verify-checksums", "Verify Checksums", { disabled: !hasFilesystemSelection || entry.isDirectory }),
      contextMenuItem("cut-clip", `Cut ${selectionCount || 1} Item(s)`, {
        shortcut: "Ctrl+X",
        disabled: hasZipVirtualSelection
      }),
      contextMenuItem("paste", "Paste Here", { shortcut: "Ctrl+V" })
    );
    items.push(
      contextMenuItem("copy-other", "Copy To Other Pane", { disabled: !hasFilesystemSelection }),
      contextMenuItem("move-other", "Move To Other Pane", { disabled: !hasFilesystemSelection }),
      contextMenuItem("destination", "Send To Destination", { disabled: !hasFilesystemSelection }),
      contextMenuItem("transfer", "Transfer With Policy", { disabled: !hasFilesystemSelection })
    );
    items.push({ separator: true });
    items.push(
      contextMenuItem("rename", "Rename", { shortcut: "F2", disabled: selectionCount !== 1 || hasZipVirtualSelection }),
      contextMenuItem("edit-text", "Quick Edit", {
        disabled: !entry.isFile || selectionCount !== 1 || hasZipVirtualSelection
      }),
      contextMenuItem("select-mask", "Advanced Select", { shortcut: "Ctrl+Shift+M" }),
      contextMenuItem("selection-sets", "Selection Sets"),
      contextMenuItem("bulk-rename", "Bulk Rename", { disabled: !hasFilesystemSelection }),
      contextMenuItem("shortcut", "Create Shortcut Here", { disabled: !hasFilesystemSelection }),
      contextMenuItem("link", "Create Link Here", { disabled: !hasFilesystemSelection }),
      contextMenuItem("archive", "Archive / Extract", { disabled: !hasFilesystemSelection }),
      contextMenuItem("label", "Label", { disabled: !hasSelection }),
      contextMenuItem("collection", "Add To Collection", { disabled: !hasSelection }),
      contextMenuItem("basket-add", "Add To Basket", { disabled: !hasSelection })
    );
    items.push({ separator: true });
    items.push(
      contextMenuItem("folder-sizes", "Calculate Folder Sizes"),
      contextMenuItem("properties", "Properties"),
      contextMenuItem("attributes", "Attributes", { disabled: !hasFilesystemSelection }),
      contextMenuItem("timestamps", "Timestamps", { disabled: !hasFilesystemSelection }),
      contextMenuItem("windows-properties", "Windows Properties", {
        shortcut: "Alt+Enter",
        disabled: hasZipVirtualSelection
      }),
      contextMenuItem("trash", "Move To App Trash", { danger: true, disabled: !hasFilesystemSelection }),
      contextMenuItem("recycle", "Recycle In Windows", { danger: true, disabled: !hasFilesystemSelection }),
      contextMenuItem("delete", "Delete Permanently", { danger: true, disabled: !hasFilesystemSelection })
    );
    return items;
  }

  items.push(
    contextMenuItem("paste", "Paste Here", { shortcut: "Ctrl+V" }),
    contextMenuItem("copy-names", "Copy Folder Path"),
    contextMenuItem("new-file", "New File"),
    contextMenuItem("new-folder", "New Folder"),
    contextMenuItem("refresh", "Refresh", { shortcut: "R" })
  );
  items.push({ separator: true });
  items.push(
      contextMenuItem("folder-sizes", "Calculate Visible Folder Sizes"),
      contextMenuItem("properties", "Folder Properties"),
      contextMenuItem("windows-properties", "Windows Folder Properties", { shortcut: "Alt+Enter" }),
      contextMenuItem("shell-verbs", "Folder Shell Verbs"),
      contextMenuItem("favorite", "Add Folder To Favorites"),
    contextMenuItem("search", "Search Here"),
    contextMenuItem("flat", "Flat View")
  );
  items.push({ separator: true });
  items.push(
    contextMenuItem("select-mask", "Advanced Select", { shortcut: "Ctrl+Shift+M" }),
    contextMenuItem("selection-sets", "Selection Sets"),
    contextMenuItem("columns", "Details Columns"),
    contextMenuItem("formats", "Folder Formats"),
    contextMenuItem("presets", "Display Presets")
  );
  return items;
}

function renderContextMenu() {
  const menuEl = document.getElementById("context-menu");
  if (!menuEl || !app.contextMenu) {
    return;
  }
  const header =
    app.contextMenu.type === "columns"
      ? `${columnDefById(app.contextMenu.columnId)?.title || "Columns"} Columns`
      : app.contextMenu.entryPath
        ? labelForPath(app.contextMenu.entryPath)
        : labelForPath(tabOf(app.contextMenu.paneName).path);
  const items = contextMenuItems(app.contextMenu);
  menuEl.innerHTML = `
    <div class="context-menu-title">${escapeHtml(header)}</div>
    ${items
      .map((item) => {
        if (item.separator) {
          return `<div class="context-menu-separator"></div>`;
        }
        return `<button class="${item.danger ? "danger" : ""}" data-context-action="${escapeHtml(
          item.action
        )}" ${item.disabled ? "disabled" : ""}>
          <span>${escapeHtml(item.label)}</span>
          ${item.shortcut ? `<kbd>${escapeHtml(item.shortcut)}</kbd>` : ""}
        </button>`;
      })
      .join("")}
  `;
  menuEl.hidden = false;
  menuEl.style.left = `${app.contextMenu.x}px`;
  menuEl.style.top = `${app.contextMenu.y}px`;
  const rect = menuEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(app.contextMenu.x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(app.contextMenu.y, window.innerHeight - rect.height - 8));
  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;
}

function hideContextMenu() {
  const menuEl = document.getElementById("context-menu");
  app.contextMenu = null;
  if (menuEl) {
    menuEl.hidden = true;
    menuEl.innerHTML = "";
  }
}

function prepareContextSelection(paneName, entryPath) {
  app.activePane = paneName;
  updateActivePaneChrome();
  if (!entryPath) {
    const tab = tabOf(paneName);
    tab.selected = new Set();
    tab.focusedPath = null;
    tab.anchorPath = null;
    commitSelectionChange(paneName, { focusList: false, scroll: false });
    focusPaneList(paneName);
    renderInspector();
    return;
  }
  const tab = tabOf(paneName);
  if (!tab.selected.has(entryPath)) {
    tab.selected = new Set([entryPath]);
    tab.anchorPath = entryPath;
  }
  tab.focusedPath = entryPath;
  commitSelectionChange(paneName, { focusList: false, scroll: false });
}

function openContextMenu(event) {
  if (document.querySelector("dialog[open]")) {
    return false;
  }
  const columnButton = event.target.closest?.("[data-column-id]");
  const columnHead = event.target.closest?.(".file-head");
  if (columnButton || columnHead) {
    const pane = event.target.closest?.(".pane[data-pane]");
    const paneName = pane?.dataset.pane;
    if (!isPaneName(paneName)) {
      return false;
    }
    event.preventDefault();
    app.activePane = paneName;
    updateActivePaneChrome();
    app.contextMenu = {
      type: "columns",
      paneName,
      columnId: columnButton?.dataset.columnId || columnsForTab(tabOf(paneName))[0]?.id || "name",
      x: event.clientX,
      y: event.clientY
    };
    renderContextMenu();
    return true;
  }
  const row = event.target.closest?.("[data-entry-path]");
  const fileList = event.target.closest?.("[data-list]");
  const pane = event.target.closest?.(".pane[data-pane]");
  const paneName = row?.dataset.pane || fileList?.dataset.list || pane?.dataset.pane;
  if (!isPaneName(paneName)) {
    return false;
  }
  event.preventDefault();
  prepareContextSelection(paneName, row?.dataset.entryPath || null);
  app.contextMenu = {
    paneName,
    entryPath: row?.dataset.entryPath || null,
    x: event.clientX,
    y: event.clientY
  };
  renderContextMenu();
  return true;
}

async function executeContextAction(action) {
  const menu = app.contextMenu;
  if (!menu) {
    return;
  }
  const paneName = menu.paneName;
  const entry = contextEntry();
  const openWithPresetPrefix = "open-with-preset:";
  const openWithPresetId = action.startsWith(openWithPresetPrefix) ? action.slice(openWithPresetPrefix.length) : "";
  const openWithPresetTargets = openWithPresetId ? contextOpenWithTargets(menu) : null;
  hideContextMenu();
  try {
    if (openWithPresetId) {
      await runContextOpenWithPreset(paneName, openWithPresetId, openWithPresetTargets);
      return;
    }
    if (action.startsWith("column-sort:")) {
      const [, sortKey, direction] = action.split(":");
      await sortPaneByColumn(paneName, sortKey, direction);
      return;
    }
    if (action.startsWith("column-autosize:")) {
      autosizeColumn(paneName, action.slice("column-autosize:".length));
      return;
    }
    if (action.startsWith("column-toggle:")) {
      await toggleColumn(paneName, action.slice("column-toggle:".length));
      return;
    }
    if (action.startsWith("column-preset:")) {
      await applyColumnPreset(paneName, action.slice("column-preset:".length));
      return;
    }
    if (action === "column-autosize-all") {
      autosizeAllColumns(paneName);
      return;
    }
    if (action === "column-reset-widths") {
      resetColumnWidths(paneName);
      return;
    }
    if (action === "column-reset-default") {
      await resetColumnsToDefault(paneName);
      return;
    }
    if (action === "column-save-format") {
      await saveCurrentFolderFormat();
      return;
    }
    if (action === "open" && entry) await openEntry(paneName, entry.path);
    if (action === "open-new-tab" && entry) {
      const targetPath = isRealZipFileEntry(entry) ? zipVirtualPathFor(entry.path, "") : entry.path;
      if (entry.isDirectory || isRealZipFileEntry(entry)) {
        await openFolderInNewTab(paneName, targetPath);
      }
    }
    if (action === "viewer" && entry) await openViewer(paneName, entry.path);
    if (action === "open-other" && entry) {
      const targetPath = isRealZipFileEntry(entry) ? zipVirtualPathFor(entry.path, "") : entry.path;
      if (entry.isDirectory || isRealZipFileEntry(entry)) {
        await loadPane(otherPane(paneName), targetPath);
      }
    }
    if (action === "open-with") openOpenWithDialog(paneName);
    if (action === "shell-verbs") await openShellVerbsDialog(paneName, entry?.path);
    if (action === "reveal") await revealSelected();
    if (action === "copy-clip") await copySelectionToClipboard(paneName);
    if (action === "copy-names") openCopyNamesDialog(paneName);
    if (action === "checksums") openChecksumsDialog(paneName);
    if (action === "verify-checksums") {
      openChecksumsDialog(paneName);
      await verifyChecksumManifest();
    }
    if (action === "cut-clip") await cutSelectionToClipboard(paneName);
    if (action === "paste") await pasteFileClipboard(paneName);
    if (action === "copy-other") await copyToOther(paneName);
    if (action === "move-other") await moveToOther(paneName);
    if (action === "destination") await openDestinationDialog(paneName);
    if (action === "transfer") openTransferDialog(paneName);
    if (action === "rename") await renameSelected(paneName);
    if (action === "edit-text" && entry) await openTextEditor(paneName, entry.path);
    if (action === "select-mask") openSelectMaskDialog(paneName);
    if (action === "selection-sets") await openSelectionSetsDialog(paneName);
    if (action === "bulk-rename") openBulkRenameDialog(paneName);
    if (action === "shortcut") await createShortcutsForSelection(paneName);
    if (action === "link") openLinkDialog(paneName);
    if (action === "archive") openArchiveDialog(paneName);
    if (action === "label") await openLabelsDialog(paneName);
    if (action === "collection") await addSelectionToCollection();
    if (action === "basket-add") await addSelectionToBasket(paneName);
    if (action === "folder-sizes") await calculateFolderSizes(paneName);
    if (action === "properties") openPropertiesDialog(paneName);
    if (action === "attributes") openAttributesDialog(paneName);
    if (action === "timestamps") openTimestampsDialog(paneName);
    if (action === "windows-properties") await openWindowsProperties(paneName, entry?.path);
    if (action === "trash") await trashSelected(paneName);
    if (action === "recycle") await recycleSelected(paneName);
    if (action === "delete") await deleteSelectedPermanently(paneName);
    if (action === "new-file") openNewFileDialog(paneName);
    if (action === "new-folder") await newFolder(paneName);
    if (action === "refresh") await refreshPane(paneName);
    if (action === "favorite") await addFavorite(paneName);
    if (action === "search") await deepSearch(paneName);
    if (action === "flat") openFlatDialog();
    if (action === "columns") await openColumnsDialog(paneName);
    if (action === "formats") await openFormatsDialog(paneName);
    if (action === "presets") await openDisplayPresetsDialog(paneName);
  } catch (error) {
    showToast(error.message);
  }
}

async function syncStateAndChrome() {
  await loadState();
  await loadIntegrationStatus();
  applyAppSettingsChrome();
  renderRoots();
  renderSavedCommandStrip();
  renderToolManager();
  renderHotkeys();
  renderBackupDialog();
  renderScriptLibrary();
  renderAliasesDialog();
  renderCollections();
  renderBasket();
  renderPaneSnapshots();
  renderColumnsDialog();
  renderFolderFormats();
  renderDisplayPresets();
  renderFilterPresets();
  renderSyncProfiles();
  renderOpenWithPresets();
  renderSelectPresets();
  renderSelectionSetsDialog();
  renderBulkRenamePresets();
  renderToolbarDialog();
  renderLabelsDialog();
  renderLayouts();
  renderTabGroups();
  renderOperations();
  renderIntegration();
  renderPreferencesDialog();
  updateClipboardReadout();
  renderPasteConflictMode();
  renderAutoRefreshToggle();
  renderShowHiddenToggle();
  renderLinkedNavigationToggle();
}

function operationPollDelay() {
  if (document.hidden) {
    return activeOperations().length ? 3000 : 10000;
  }
  return activeOperations().length ? 1200 : 2500;
}

function scheduleOperationPoll(delay = operationPollDelay()) {
  clearTimeout(app.operationPollTimer);
  app.operationPollTimer = setTimeout(async () => {
    await pollOperationState({ silent: true });
    scheduleOperationPoll();
  }, delay);
}

async function pollOperationState({ silent = false } = {}) {
  if (app.operationPollBusy || !app.state) {
    return;
  }
  app.operationPollBusy = true;
  const previousActive = activeOperations().map((operation) => operation.id);
  try {
    const state = await request("/api/state");
    const nextOperations = Array.isArray(state.operations) ? state.operations : [];
    app.state.operations = nextOperations;
    const finished = previousActive
      .map((operationId) => nextOperations.find((operation) => operation.id === operationId))
      .filter((operation) => operation && !operationIsActive(operation));
    renderOperations();
    if (finished.length && !silent) {
      setStatus(`${finished.length} operation${finished.length === 1 ? "" : "s"} finished`);
    }
  } catch (error) {
    if (!silent) {
      setStatus(error.message);
    }
  } finally {
    app.operationPollBusy = false;
  }
}

function startOperationPolling() {
  scheduleOperationPoll(1200);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      pollOperationState({ silent: true });
    }
    scheduleOperationPoll(250);
  });
}

function autoRefreshDelay() {
  return document.hidden ? 10000 : 2500;
}

function watchablePaneNames() {
  return ["left", "right"].filter((paneName) => {
    const tab = tabOf(paneName);
    return Boolean(tab?.path && !tab.searchMode && !tab.virtualMode);
  });
}

function scheduleAutoRefresh(delay = autoRefreshDelay()) {
  clearTimeout(app.autoRefreshTimer);
  if (!autoRefreshEnabled() || delay === null) {
    return;
  }
  app.autoRefreshTimer = setTimeout(async () => {
    await pollAutoRefresh();
    scheduleAutoRefresh();
  }, delay);
}

async function folderSignatureForPath(itemPath, options = {}) {
  const query = new URLSearchParams({
    path: itemPath,
    showHidden: showHiddenEntriesEnabled() ? "true" : "false",
    includeDimensions: options.includeDimensions ? "true" : "false",
    includeLinks: options.includeLinks ? "true" : "false",
    includeAttributes: options.includeAttributes ? "true" : "false"
  });
  return request(`/api/folder-signature?${query}`);
}

async function folderWatchForPath(itemPath, since = null) {
  const query = new URLSearchParams({ path: itemPath });
  if (Number.isFinite(Number(since))) {
    query.set("since", String(Number(since)));
  }
  return request(`/api/folder-watch?${query}`);
}

function signatureChanged(previous, next) {
  if (!previous?.signature || !next?.signature) {
    return false;
  }
  return previous.signature !== next.signature || previous.truncated !== next.truncated;
}

async function pollAutoRefresh({ force = false } = {}) {
  if (app.autoRefreshBusy || !app.state || (!force && (!autoRefreshEnabled() || document.hidden))) {
    return;
  }
  app.autoRefreshBusy = true;
  const refreshed = [];
  try {
    for (const paneName of watchablePaneNames()) {
      if (paneLoadInFlight(paneName)) {
        continue;
      }
      const tab = tabOf(paneName);
      const previous = tab.folderSignature;
      const watch = await folderWatchForPath(tab.path, tab.folderWatchVersion);
      if (watch.available) {
        if (!Number.isFinite(Number(tab.folderWatchVersion))) {
          tab.folderWatchVersion = Number(watch.version || 0);
          continue;
        }
        if (watch.changed) {
          await refreshPane(paneName, {
            preserveSelection: true,
            save: false,
            silent: true
          });
          tab.folderWatchVersion = Number(watch.version || 0);
          refreshed.push(paneName);
        } else {
          tab.folderWatchVersion = Number(watch.version || 0);
        }
        continue;
      }
      const next = await folderSignatureForPath(tab.path, {
        includeDimensions: tab.listingIncludesDimensions === true || tabNeedsDimensions(tab),
        includeLinks: tab.listingIncludesLinks === true || tabNeedsLinks(tab),
        includeAttributes:
          tab.listingIncludesAttributes === true ||
          tabNeedsAttributes(tab) ||
          !showHiddenEntriesEnabled()
      });
      if (!previous?.signature) {
        tab.folderSignature = next;
        continue;
      }
      if (signatureChanged(previous, next)) {
        await refreshPane(paneName, {
          preserveSelection: true,
          save: false,
          silent: true
        });
        refreshed.push(paneName);
      } else {
        tab.folderSignature = next;
      }
    }
    if (refreshed.length) {
      setStatus(`Auto refreshed ${refreshed.map((paneName) => paneName.toUpperCase()).join(" / ")}`);
    }
  } catch (error) {
    if (force) {
      setStatus(error.message);
    }
  } finally {
    app.autoRefreshBusy = false;
  }
}

function startAutoRefresh() {
  renderAutoRefreshToggle();
  renderShowHiddenToggle();
  scheduleAutoRefresh(1600);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      pollAutoRefresh({ force: true });
    }
    scheduleAutoRefresh(250);
  });
}

function commandContext() {
  return {
    activePath: tabOf(app.activePane).path,
    otherPath: tabOf(otherPane(app.activePane)).path,
    selectedPaths: selectedPaths(app.activePane)
  };
}

function currentTool() {
  const commands = app.state?.commands || [];
  return commands.find((command) => command.id === app.activeToolId) || commands[0] || null;
}

function packageableTool(command) {
  const allowedKinds = new Set(["powershell", "cmd"]);
  return {
    id: String(command?.id || crypto.randomUUID()),
    name: String(command?.name || "Untitled Command").trim().slice(0, 80),
    description: String(command?.description || "").trim().slice(0, 240),
    kind: allowedKinds.has(command?.kind) ? command.kind : "powershell",
    showInToolbar: Boolean(command?.showInToolbar),
    command: String(command?.command || "").slice(0, 8000)
  };
}

function updateToolPackageSummary(message = null) {
  const summary = document.getElementById("tool-package-summary");
  if (!summary) {
    return;
  }
  const count = app.state?.commands?.length || 0;
  summary.textContent = message || `${count} saved tool${count === 1 ? "" : "s"} ready for package export.`;
}

function toolPackageFilename() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return `explore-better-tools-${stamp}.json`;
}

function buildToolPackage() {
  return {
    schema: "explore-better.tools.v1",
    app: "Explore Better",
    version: 1,
    exportedAt: new Date().toISOString(),
    tools: (app.state?.commands || []).map(packageableTool)
  };
}

function exportToolPackage() {
  const toolPackage = buildToolPackage();
  if (!toolPackage.tools.length) {
    updateToolPackageSummary("No tools to export.");
    return showToast("No tools to export");
  }
  const blob = new Blob([`${JSON.stringify(toolPackage, null, 2)}\n`], {
    type: "application/json"
  });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = toolPackageFilename();
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  updateToolPackageSummary(`Exported ${toolPackage.tools.length} tool(s).`);
  showToast("Tool package exported");
}

function toolsFromPackage(toolPackage) {
  if (Array.isArray(toolPackage)) {
    return toolPackage;
  }
  if (Array.isArray(toolPackage?.tools)) {
    return toolPackage.tools;
  }
  if (Array.isArray(toolPackage?.commands)) {
    return toolPackage.commands;
  }
  return [];
}

function normalizeImportedTools(rawTools) {
  const seenIds = new Set();
  return rawTools
    .slice(0, 200)
    .map((source, index) => {
      if (!source || typeof source !== "object") {
        return null;
      }
      const tool = packageableTool({
        ...source,
        id: source.id || crypto.randomUUID(),
        name: source.name || `Imported Tool ${index + 1}`
      });
      if (!tool.command.trim()) {
        return null;
      }
      if (seenIds.has(tool.id)) {
        tool.id = crypto.randomUUID();
      }
      seenIds.add(tool.id);
      return tool;
    })
    .filter(Boolean);
}

function mergeImportedTools(existingCommands, importedTools, replaceExisting) {
  if (replaceExisting) {
    return {
      commands: importedTools,
      added: importedTools.length,
      updated: 0,
      replaced: existingCommands.length
    };
  }
  const commands = existingCommands.map(packageableTool);
  const indexById = new Map(commands.map((command, index) => [command.id, index]));
  let added = 0;
  let updated = 0;
  for (const tool of importedTools) {
    const existingIndex = indexById.get(tool.id);
    if (existingIndex === undefined) {
      indexById.set(tool.id, commands.length);
      commands.push(tool);
      added += 1;
    } else {
      commands[existingIndex] = tool;
      updated += 1;
    }
  }
  return { commands, added, updated, replaced: 0 };
}

async function importToolPackageFile(file) {
  if (!file) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    updateToolPackageSummary("Import failed: invalid JSON.");
    throw new Error(`Invalid tool package JSON: ${error.message}`);
  }
  const importedTools = normalizeImportedTools(toolsFromPackage(parsed));
  if (!importedTools.length) {
    updateToolPackageSummary("Import failed: no runnable tools found.");
    return showToast("No runnable tools found");
  }
  const replaceExisting = Boolean(document.getElementById("tool-import-replace")?.checked);
  const currentCount = app.state?.commands?.length || 0;
  const verb = replaceExisting ? `replace ${currentCount} saved tool(s) with` : "merge";
  if (!confirm(`Import ${importedTools.length} trusted tool(s) and ${verb} this package?`)) {
    updateToolPackageSummary("Import canceled.");
    return;
  }
  const result = mergeImportedTools(app.state?.commands || [], importedTools, replaceExisting);
  app.state.commands = result.commands;
  app.activeToolId = importedTools[0]?.id || app.state.commands[0]?.id || null;
  await saveStateNow();
  renderToolManager();
  updateToolPackageSummary(
    replaceExisting
      ? `Imported ${result.added} tool(s), replacing ${result.replaced}.`
      : `Imported ${result.added} new and updated ${result.updated}.`
  );
  showToast("Tool package imported");
}

function openToolPackageFilePicker() {
  const input = document.getElementById("tool-package-file");
  if (!input) {
    return;
  }
  input.value = "";
  input.click();
}

function renderToolManager() {
  renderSavedCommandStrip();
  const list = document.getElementById("tool-list");
  if (!list) {
    return;
  }
  const commands = app.state?.commands || [];
  if (!app.activeToolId && commands[0]) {
    app.activeToolId = commands[0].id;
  }
  list.innerHTML = commands.length
    ? commands
        .map(
          (command) =>
            `<button class="${command.id === app.activeToolId ? "active" : ""}" data-select-tool="${escapeHtml(
              command.id
            )}">
              <span>${escapeHtml(command.name)}</span>
              <small>${escapeHtml(command.kind)}${command.showInToolbar ? " / toolbar" : ""}</small>
            </button>`
        )
        .join("")
    : `<div class="empty-state">No tools</div>`;
  fillToolForm(currentTool());
  updateToolPackageSummary();
}

function fillToolForm(command) {
  document.getElementById("tool-id").value = command?.id || "";
  document.getElementById("tool-name").value = command?.name || "";
  document.getElementById("tool-kind").value = command?.kind || "powershell";
  document.getElementById("tool-description").value = command?.description || "";
  document.getElementById("tool-toolbar").checked = Boolean(command?.showInToolbar);
  document.getElementById("tool-command").value = command?.command || "";
}

function toolFromForm() {
  return {
    id: document.getElementById("tool-id").value || crypto.randomUUID(),
    name: document.getElementById("tool-name").value.trim() || "Untitled Command",
    kind: document.getElementById("tool-kind").value,
    description: document.getElementById("tool-description").value.trim(),
    showInToolbar: document.getElementById("tool-toolbar").checked,
    command: document.getElementById("tool-command").value
  };
}

async function openToolsDialog() {
  await loadState();
  renderToolManager();
  document.getElementById("tools-dialog").showModal();
}

function commandIdFromName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function builtinCommandId(command, index = 0) {
  return commandIdFromName(command?.name) || `command-${index + 1}`;
}

function hotkeyTargetValue(type, id) {
  return `${type}:${id}`;
}

function parseHotkeyTargetValue(value) {
  const text = String(value || "");
  const splitAt = text.indexOf(":");
  if (splitAt === -1) {
    return null;
  }
  const targetType = text.slice(0, splitAt);
  const targetId = text.slice(splitAt + 1);
  if (!["command", "tool", "script"].includes(targetType) || !targetId) {
    return null;
  }
  return { targetType, targetId };
}

function hotkeyTargetTypeLabel(type) {
  if (type === "command") return "Command";
  if (type === "tool") return "Tool";
  if (type === "script") return "Script";
  return "Action";
}

function ensureSettings() {
  if (!app.state) {
    return {};
  }
  app.state.settings = app.state.settings || {};
  return app.state.settings;
}

function normalizeHotkey(hotkey) {
  const combo = String(hotkey?.combo || "").trim();
  const targetType = String(hotkey?.targetType || "");
  const targetId = String(hotkey?.targetId || "").trim();
  if (!combo || !["command", "tool", "script"].includes(targetType) || !targetId) {
    return null;
  }
  const timestamp = new Date().toISOString();
  return {
    id: String(hotkey?.id || crypto.randomUUID()),
    combo,
    targetType,
    targetId,
    createdAt: hotkey?.createdAt || timestamp,
    updatedAt: hotkey?.updatedAt || hotkey?.createdAt || timestamp
  };
}

function hotkeys() {
  const settings = ensureSettings();
  const normalized = Array.isArray(settings.hotkeys) ? settings.hotkeys.map(normalizeHotkey).filter(Boolean) : [];
  settings.hotkeys = normalized;
  return normalized;
}

function hotkeyTargetOptions() {
  return [
    ...commands.map((command, index) => ({
      type: "command",
      id: builtinCommandId(command, index),
      label: command.name,
      detail: command.detail,
      group: "Commands"
    })),
    ...(app.state?.commands || []).map((tool) => ({
      type: "tool",
      id: tool.id,
      label: tool.name || "Untitled Tool",
      detail: tool.description || tool.kind || "Saved tool",
      group: "Tools"
    })),
    ...(app.state?.scripts || []).map((script) => ({
      type: "script",
      id: script.id,
      label: script.name || "Untitled Script",
      detail: script.description || "Saved script",
      group: "Scripts"
    }))
  ].filter((target) => target.id);
}

function hotkeyTargetOption(targetType, targetId) {
  return hotkeyTargetOptions().find((target) => target.type === targetType && target.id === targetId) || null;
}

function hotkeyLabel(hotkey) {
  const target = hotkeyTargetOption(hotkey?.targetType, hotkey?.targetId);
  if (target) {
    return target.label;
  }
  return `${hotkeyTargetTypeLabel(hotkey?.targetType)} missing target`;
}

function hotkeyDetail(hotkey) {
  const target = hotkeyTargetOption(hotkey?.targetType, hotkey?.targetId);
  if (target) {
    return `${hotkeyTargetTypeLabel(target.type)} / ${target.detail}`;
  }
  return `${hotkeyTargetTypeLabel(hotkey?.targetType)} target is missing`;
}

function comboKey(combo) {
  return String(combo || "").trim().toLowerCase();
}

function defaultHotkeyTarget() {
  const targets = hotkeyTargetOptions();
  return (
    targets.find((target) => target.type === "command" && target.id === "open-operation-history") ||
    targets.find((target) => target.type === "command") ||
    targets[0] ||
    null
  );
}

function defaultHotkeyDraft() {
  const target = defaultHotkeyTarget();
  return {
    id: "",
    combo: "",
    targetType: target?.type || "command",
    targetId: target?.id || ""
  };
}

function currentHotkey() {
  const list = hotkeys();
  return list.find((hotkey) => hotkey.id === app.activeHotkeyId) || list[0] || null;
}

function hotkeySelectMarkup(selectedValue) {
  const targets = hotkeyTargetOptions();
  const hasSelectedTarget = selectedValue && targets.some((target) => hotkeyTargetValue(target.type, target.id) === selectedValue);
  const groups = ["Commands", "Tools", "Scripts"];
  const groupMarkup = groups
    .map((group) => {
      const items = targets.filter((target) => target.group === group);
      if (!items.length) {
        return "";
      }
      return `<optgroup label="${escapeHtml(group)}">${items
        .map((target) => {
          const value = hotkeyTargetValue(target.type, target.id);
          const selected = value === selectedValue ? " selected" : "";
          return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(target.label)}</option>`;
        })
        .join("")}</optgroup>`;
    })
    .join("");
  if (selectedValue && !hasSelectedTarget) {
    return `<option value="${escapeHtml(selectedValue)}" selected>Missing target</option>${groupMarkup}`;
  }
  return groupMarkup;
}

function fillHotkeyForm(hotkey = null) {
  const draft = hotkey || defaultHotkeyDraft();
  const selectedValue = draft.targetId ? hotkeyTargetValue(draft.targetType, draft.targetId) : "";
  const select = document.getElementById("hotkey-target");
  if (!select) {
    return;
  }
  document.getElementById("hotkey-id").value = draft.id || "";
  document.getElementById("hotkey-combo").value = draft.combo || "";
  select.innerHTML = hotkeySelectMarkup(selectedValue);
  if (!selectedValue) {
    const target = defaultHotkeyTarget();
    if (target) {
      select.value = hotkeyTargetValue(target.type, target.id);
    }
  }
  updateHotkeyConflict();
}

function updateHotkeyConflict(message = "") {
  const summary = document.getElementById("hotkey-conflict");
  if (!summary) {
    return;
  }
  if (message) {
    summary.textContent = message;
    return;
  }
  const combo = document.getElementById("hotkey-combo")?.value || "";
  if (!combo) {
    summary.textContent = "Press a shortcut, choose an action, then save.";
    return;
  }
  const activeId = document.getElementById("hotkey-id")?.value || "";
  const duplicate = hotkeys().find((hotkey) => comboKey(hotkey.combo) === comboKey(combo) && hotkey.id !== activeId);
  summary.textContent = duplicate ? `Already assigned to ${hotkeyLabel(duplicate)}.` : "Shortcut is available.";
}

function renderHotkeys() {
  const list = document.getElementById("hotkey-list");
  if (!list) {
    return;
  }
  const savedHotkeys = hotkeys();
  if (!app.activeHotkeyId && savedHotkeys[0]) {
    app.activeHotkeyId = savedHotkeys[0].id;
  }
  const active = currentHotkey();
  document.getElementById("hotkey-summary").textContent = `${savedHotkeys.length} saved`;
  list.innerHTML = savedHotkeys.length
    ? savedHotkeys
        .map(
          (hotkey) =>
            `<button class="${hotkey.id === active?.id ? "active" : ""}" data-select-hotkey="${escapeHtml(hotkey.id)}">
              <kbd>${escapeHtml(hotkey.combo)}</kbd>
              <span>${escapeHtml(hotkeyLabel(hotkey))}</span>
              <small>${escapeHtml(hotkeyDetail(hotkey))}</small>
            </button>`
        )
        .join("")
    : `<div class="empty-state">No custom hotkeys</div>`;
  fillHotkeyForm(active);
}

async function openHotkeysDialog() {
  await loadState();
  renderHotkeys();
  const dialog = document.getElementById("hotkeys-dialog");
  dialog.showModal();
  document.getElementById("hotkey-combo").focus();
}

function newHotkey() {
  app.activeHotkeyId = null;
  fillHotkeyForm(defaultHotkeyDraft());
  document.getElementById("hotkey-combo").focus();
}

async function saveHotkeyFromForm() {
  if (!app.state) {
    await loadState();
  }
  const combo = document.getElementById("hotkey-combo").value.trim();
  if (!combo) {
    throw new Error("Press a shortcut first.");
  }
  const parsed = parseHotkeyTargetValue(document.getElementById("hotkey-target").value);
  if (!parsed) {
    throw new Error("Choose an action for this hotkey.");
  }
  const id = document.getElementById("hotkey-id").value || crypto.randomUUID();
  const savedHotkeys = hotkeys();
  const duplicate = savedHotkeys.find((hotkey) => comboKey(hotkey.combo) === comboKey(combo) && hotkey.id !== id);
  if (duplicate) {
    throw new Error(`That shortcut is already assigned to ${hotkeyLabel(duplicate)}.`);
  }
  const existing = savedHotkeys.find((hotkey) => hotkey.id === id);
  const hotkey = {
    id,
    combo,
    targetType: parsed.targetType,
    targetId: parsed.targetId,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const index = savedHotkeys.findIndex((item) => item.id === id);
  if (index === -1) {
    savedHotkeys.push(hotkey);
  } else {
    savedHotkeys[index] = hotkey;
  }
  ensureSettings().hotkeys = savedHotkeys;
  app.activeHotkeyId = id;
  await saveStateNow();
  renderHotkeys();
  showToast("Hotkey saved");
}

async function deleteActiveHotkey() {
  const hotkey = currentHotkey();
  if (!hotkey) {
    newHotkey();
    return;
  }
  if (!confirm(`Delete ${hotkey.combo} for ${hotkeyLabel(hotkey)}?`)) {
    return;
  }
  ensureSettings().hotkeys = hotkeys().filter((item) => item.id !== hotkey.id);
  app.activeHotkeyId = ensureSettings().hotkeys[0]?.id || null;
  await saveStateNow();
  renderHotkeys();
  showToast("Hotkey deleted");
}

function keyNameForHotkey(event) {
  const key = event.key;
  const modifierKeys = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);
  if (!key || modifierKeys.has(key)) {
    return "";
  }
  if (event.code === "Space" || key === " ") {
    return "Space";
  }
  if (/^[a-z]$/i.test(key)) {
    return key.toUpperCase();
  }
  if (/^\d$/.test(key)) {
    return key;
  }
  if (/^F\d{1,2}$/i.test(key)) {
    return key.toUpperCase();
  }
  if (key === "+") {
    return "Plus";
  }
  const aliases = {
    Esc: "Escape",
    Del: "Delete",
    "Arrow Left": "ArrowLeft",
    "Arrow Right": "ArrowRight",
    "Arrow Up": "ArrowUp",
    "Arrow Down": "ArrowDown"
  };
  return aliases[key] || key;
}

function normalizeHotkeyComboFromEvent(event) {
  const keyName = keyNameForHotkey(event);
  if (!keyName) {
    return "";
  }
  const hasModifier = event.ctrlKey || event.altKey || event.shiftKey || event.metaKey;
  const isFunctionKey = /^F(?:[1-9]|1\d|2[0-4])$/.test(keyName);
  if (!hasModifier && !isFunctionKey) {
    return "";
  }
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  parts.push(keyName);
  return parts.join("+");
}

function captureHotkeyInput(event) {
  if (event.key === "Tab") {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if ((event.key === "Backspace" || event.key === "Delete") && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
    document.getElementById("hotkey-combo").value = "";
    updateHotkeyConflict("Shortcut cleared.");
    return;
  }
  const combo = normalizeHotkeyComboFromEvent(event);
  if (!combo) {
    updateHotkeyConflict("Use a modifier with the key, such as Ctrl+Alt+O.");
    return;
  }
  document.getElementById("hotkey-combo").value = combo;
  updateHotkeyConflict();
}

async function runHotkey(hotkey) {
  if (hotkey.targetType === "command") {
    const command = commands.find((item, index) => builtinCommandId(item, index) === hotkey.targetId);
    if (!command) {
      throw new Error("Hotkey command target is missing.");
    }
    await command.run();
    return;
  }
  if (hotkey.targetType === "tool") {
    await runTool(hotkey.targetId);
    return;
  }
  if (hotkey.targetType === "script") {
    await runSavedScript(hotkey.targetId);
    return;
  }
  throw new Error("Hotkey target is not supported.");
}

async function runHotkeyFromForm() {
  const parsed = parseHotkeyTargetValue(document.getElementById("hotkey-target").value);
  if (!parsed) {
    throw new Error("Choose an action first.");
  }
  const dialog = document.getElementById("hotkeys-dialog");
  if (dialog?.open) {
    dialog.close();
  }
  await runHotkey(parsed);
}

async function handleCustomHotkey(event) {
  if (event.defaultPrevented || event.repeat || document.querySelector("dialog[open]") || isTypingTarget(event.target)) {
    return false;
  }
  const combo = normalizeHotkeyComboFromEvent(event);
  if (!combo) {
    return false;
  }
  const hotkey = hotkeys().find((item) => comboKey(item.combo) === comboKey(combo));
  if (!hotkey) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  try {
    await runHotkey(hotkey);
  } catch (error) {
    showToast(error.message);
  }
  return true;
}

const configPackageArrayKeys = [
  "favorites",
  "aliases",
  "recentLocations",
  "fileBasket",
  "layouts",
  "tabGroups",
  "collections",
  "paneSnapshots",
  "selectionSets",
  "labels",
  "folderFormats",
  "displayPresets",
  "filterPresets",
  "syncProfiles",
  "openWithPresets",
  "searchPresets",
  "selectPresets",
  "bulkRenamePresets",
  "scripts",
  "commands"
];

const configPackageLabels = {
  favorites: "Favorites",
  aliases: "Aliases",
  recentLocations: "Recents",
  fileBasket: "File Basket",
  layouts: "Layouts",
  tabGroups: "Tab Groups",
  collections: "Collections",
  paneSnapshots: "Snapshots",
  selectionSets: "Selection Sets",
  labels: "Labels",
  folderFormats: "Formats",
  displayPresets: "Display Presets",
  filterPresets: "Filter Presets",
  syncProfiles: "Sync Profiles",
  openWithPresets: "Open With Presets",
  searchPresets: "Search Presets",
  selectPresets: "Select Presets",
  bulkRenamePresets: "Rename Presets",
  scripts: "Scripts",
  commands: "Tools"
};

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function configPackageFilename() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return `explore-better-config-${stamp}.json`;
}

function downloadJsonPackage(packageData, filename) {
  const blob = new Blob([`${JSON.stringify(packageData, null, 2)}\n`], {
    type: "application/json"
  });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function configurationSnapshotFromState(state = app.state) {
  const source = state || {};
  const snapshot = {
    layout: jsonClone(serializeLayout()),
    settings: jsonClone(source.settings || {})
  };
  for (const key of configPackageArrayKeys) {
    snapshot[key] = jsonClone(source[key] || []);
  }
  return snapshot;
}

function buildConfigPackage() {
  if (!app.state) {
    throw new Error("State is not loaded yet.");
  }
  const configuration = configurationSnapshotFromState(app.state);
  return {
    schema: "explore-better.config.v1",
    app: "Explore Better",
    version: 1,
    exportedAt: new Date().toISOString(),
    configuration
  };
}

function configPackageStats(configuration = configurationSnapshotFromState(app.state)) {
  const settings = configuration.settings || {};
  return [
    ...configPackageArrayKeys.map((key) => ({
      key,
      label: configPackageLabels[key],
      count: Array.isArray(configuration[key]) ? configuration[key].length : 0
    })),
    {
      key: "hotkeys",
      label: "Hotkeys",
      count: Array.isArray(settings.hotkeys) ? settings.hotkeys.length : 0
    },
    {
      key: "settings",
      label: "Settings",
      count: Object.keys(settings).length
    }
  ];
}

function renderBackupDialog(message = null, configuration = null) {
  const summary = document.getElementById("backup-summary");
  if (summary) {
    summary.textContent = message || "Ready";
  }
  const counts = document.getElementById("backup-counts");
  if (!counts) {
    return;
  }
  const stats = configPackageStats(configuration || configurationSnapshotFromState(app.state));
  counts.innerHTML = stats
    .map(
      (item) =>
        `<span>
          <strong>${escapeHtml(item.count)}</strong>
          <small>${escapeHtml(item.label)}</small>
        </span>`
    )
    .join("");
}

async function openBackupDialog() {
  await loadState();
  renderBackupDialog();
  document.getElementById("backup-output").textContent = "";
  document.getElementById("backup-dialog").showModal();
}

function exportConfigPackage() {
  const configPackage = buildConfigPackage();
  downloadJsonPackage(configPackage, configPackageFilename());
  renderBackupDialog("Exported", configPackage.configuration);
  const output = document.getElementById("backup-output");
  if (output) {
    const stats = configPackageStats(configPackage.configuration)
      .map((item) => `${item.label}: ${item.count}`)
      .join("\n");
    output.textContent = `Exported ${configPackage.schema}\n${configPackage.exportedAt}\n\n${stats}`;
  }
  showToast("Configuration package exported");
}

function configurationFromPackage(packageData) {
  const source = packageData?.configuration || packageData?.state || packageData;
  if (!source || typeof source !== "object") {
    return null;
  }
  const configuration = {};
  if (source.layout && typeof source.layout === "object") {
    configuration.layout = jsonClone(source.layout);
  }
  if (source.settings && typeof source.settings === "object") {
    configuration.settings = jsonClone(source.settings);
  }
  for (const key of configPackageArrayKeys) {
    if (Array.isArray(source[key])) {
      configuration[key] = jsonClone(source[key]);
    }
  }
  return Object.keys(configuration).length ? configuration : null;
}

function configItemKey(key, item) {
  if (item === null || item === undefined) {
    return "";
  }
  if (typeof item !== "object") {
    return `${key}:${String(item)}`;
  }
  if (item.id) return `${key}:id:${item.id}`;
  if (key === "labels" && item.path) return `${key}:path:${item.path}`;
  if (key === "aliases" && item.name) return `${key}:name:${item.name}`;
  if (item.path) return `${key}:path:${item.path}`;
  if (item.name) return `${key}:name:${item.name}`;
  return `${key}:json:${JSON.stringify(item)}`;
}

function mergeConfigArray(key, existingItems = [], importedItems = []) {
  const merged = jsonClone(existingItems);
  const indexByKey = new Map();
  merged.forEach((item, index) => {
    const itemKey = configItemKey(key, item);
    if (itemKey) {
      indexByKey.set(itemKey, index);
    }
  });
  for (const importedItem of importedItems) {
    const itemKey = configItemKey(key, importedItem);
    const clone = jsonClone(importedItem);
    if (itemKey && indexByKey.has(itemKey)) {
      merged[indexByKey.get(itemKey)] = clone;
    } else {
      if (itemKey) {
        indexByKey.set(itemKey, merged.length);
      }
      merged.push(clone);
    }
  }
  return merged;
}

function applyConfigurationToState(configuration, replaceExisting) {
  const nextState = {
    ...app.state,
    settings: jsonClone(app.state?.settings || {})
  };
  if (configuration.layout) {
    nextState.layout = jsonClone(configuration.layout);
  }
  if (configuration.settings) {
    nextState.settings = replaceExisting
      ? jsonClone(configuration.settings)
      : { ...(nextState.settings || {}), ...jsonClone(configuration.settings) };
  }
  for (const key of configPackageArrayKeys) {
    if (!Array.isArray(configuration[key])) {
      continue;
    }
    nextState[key] = replaceExisting
      ? jsonClone(configuration[key])
      : mergeConfigArray(key, nextState[key] || [], configuration[key]);
  }
  return nextState;
}

function configStatePostBody(state) {
  const body = {
    layout: state.layout,
    favorites: state.favorites || [],
    aliases: state.aliases || [],
    recentLocations: state.recentLocations || [],
    fileBasket: state.fileBasket || [],
    layouts: state.layouts || [],
    tabGroups: state.tabGroups || [],
    collections: state.collections || [],
    paneSnapshots: state.paneSnapshots || [],
    selectionSets: state.selectionSets || [],
    labels: state.labels || [],
    folderFormats: state.folderFormats || [],
    displayPresets: state.displayPresets || [],
    filterPresets: state.filterPresets || [],
    syncProfiles: state.syncProfiles || [],
    openWithPresets: state.openWithPresets || [],
    searchPresets: state.searchPresets || [],
    selectPresets: state.selectPresets || [],
    bulkRenamePresets: state.bulkRenamePresets || [],
    scripts: state.scripts || [],
    commands: state.commands || [],
    settings: state.settings || {}
  };
  return body;
}

async function reloadAfterConfigurationImport() {
  hydratePanesFromState(new URL(window.location.href).searchParams);
  await Promise.all([
    loadPane("left", tabOf("left").path || app.roots.cwd, false),
    loadPane("right", tabOf("right").path || app.roots.home, false)
  ]);
  await syncStateAndChrome();
  renderAll();
  renderInspector();
}

async function importConfigPackageFile(file) {
  if (!file) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    renderBackupDialog("Import failed");
    throw new Error(`Invalid configuration JSON: ${error.message}`);
  }
  const configuration = configurationFromPackage(parsed);
  if (!configuration) {
    renderBackupDialog("Import failed");
    return showToast("No configuration found");
  }
  const replaceExisting = Boolean(document.getElementById("backup-import-replace")?.checked);
  const stats = configPackageStats(configuration).filter((item) => item.count > 0);
  const statSummary = stats.map((item) => `${item.count} ${item.label}`).join(", ") || "layout/settings";
  const mode = replaceExisting ? "replace matching sections with" : "merge";
  if (!confirm(`Import ${statSummary} and ${mode} this configuration package?`)) {
    renderBackupDialog("Import canceled", configuration);
    return;
  }
  const nextState = applyConfigurationToState(configuration, replaceExisting);
  app.state = await request("/api/state", {
    method: "POST",
    body: JSON.stringify(configStatePostBody(nextState))
  });
  app.activeToolId = null;
  app.activeScriptId = null;
  app.activeHotkeyId = null;
  app.activeCollectionId = null;
  app.activePaneSnapshotId = null;
  app.activeAliasId = null;
  app.activeTabGroupId = null;
  app.activeFolderFormatId = null;
  app.activeDisplayPresetId = null;
  app.activeSyncProfileId = null;
  app.activeOpenWithPresetId = null;
  app.activeSearchPresetId = null;
  await reloadAfterConfigurationImport();
  renderBackupDialog("Imported", configuration);
  document.getElementById("backup-output").textContent = `Imported ${parsed.schema || "configuration package"}\nMode: ${
    replaceExisting ? "replace" : "merge"
  }\n\n${stats.map((item) => `${item.label}: ${item.count}`).join("\n")}`;
  showToast("Configuration package imported");
}

function openBackupPackageFilePicker() {
  const input = document.getElementById("backup-package-file");
  if (!input) {
    return;
  }
  input.value = "";
  input.click();
}

function defaultCollectionName() {
  const stamp = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date());
  return `Collection ${stamp}`;
}

function currentCollection() {
  const collections = app.state?.collections || [];
  return collections.find((collection) => collection.id === app.activeCollectionId) || collections[0] || null;
}

function fillCollectionForm(collection = null) {
  document.getElementById("collection-id").value = collection?.id || "";
  document.getElementById("collection-name").value = collection?.name || defaultCollectionName();
  document.getElementById("collection-description").value = collection?.description || "";
}

function renderCollectionItems(collection) {
  const list = document.getElementById("collection-items");
  if (!collection?.items?.length) {
    list.innerHTML = `<div class="empty-state">No collected items</div>`;
    return;
  }
  list.innerHTML = collection.items
    .map(
      (item) =>
        `<div class="collection-item-row">
          <span>
            <strong title="${escapeHtml(item.path)}">${escapeHtml(labelForPath(item.path))}</strong>
            <small>${escapeHtml(item.path)}</small>
          </span>
          <small>${escapeHtml(formatDate(item.addedAt))}</small>
          <button data-collection-remove="${escapeHtml(item.path)}">Remove</button>
        </div>`
    )
    .join("");
}

function renderCollections() {
  const list = document.getElementById("collection-list");
  if (!list) {
    return;
  }
  const collections = app.state?.collections || [];
  if (!app.activeCollectionId && collections[0]) {
    app.activeCollectionId = collections[0].id;
  }
  const active = currentCollection();
  document.getElementById("collection-summary").textContent = `${collections.length} saved`;
  list.innerHTML = collections.length
    ? collections
        .map(
          (collection) =>
            `<button class="${collection.id === active?.id ? "active" : ""}" data-select-collection="${escapeHtml(
              collection.id
            )}">
              <span>${escapeHtml(collection.name)}</span>
              <small>${collection.items?.length || 0} items${collection.description ? ` / ${escapeHtml(collection.description)}` : ""}</small>
            </button>`
        )
        .join("")
    : `<div class="empty-state">No collections</div>`;
  fillCollectionForm(active);
  renderCollectionItems(active);
}

async function openCollectionsDialog() {
  await loadState();
  renderCollections();
  document.getElementById("collections-dialog").showModal();
}

async function saveCollectionFromForm() {
  const collectionId = document.getElementById("collection-id").value;
  const result = await request("/api/collections", {
    method: "POST",
    body: JSON.stringify({
      id: collectionId || undefined,
      name: document.getElementById("collection-name").value.trim() || defaultCollectionName(),
      description: document.getElementById("collection-description").value.trim()
    })
  });
  app.state.collections = result.collections;
  app.activeCollectionId = result.collection.id;
  renderCollections();
  showToast("Collection saved");
  return result.collection;
}

async function addSelectionToCollection(collectionId = app.activeCollectionId) {
  const paths = selectedPaths(app.activePane);
  if (!paths.length) {
    return showToast("Select items first");
  }
  const current = collectionId
    ? (app.state?.collections || []).find((collection) => collection.id === collectionId)
    : null;
  const result = await request("/api/collections/add", {
    method: "POST",
    body: JSON.stringify({
      collectionId: current?.id,
      name: current?.name || document.getElementById("collection-name")?.value || defaultCollectionName(),
      description: current?.description || document.getElementById("collection-description")?.value || "",
      paths
    })
  });
  app.state.collections = result.collections;
  app.activeCollectionId = result.collection.id;
  renderCollections();
  showToast(`Added ${paths.length} item(s)`);
}

async function removeFromActiveCollection(itemPath) {
  const collection = currentCollection();
  if (!collection) {
    return;
  }
  const result = await request("/api/collections/remove", {
    method: "POST",
    body: JSON.stringify({ collectionId: collection.id, paths: [itemPath] })
  });
  app.state.collections = result.collections;
  app.activeCollectionId = result.collection.id;
  renderCollections();
}

async function deleteActiveCollection() {
  const collection = currentCollection();
  if (!collection) {
    return;
  }
  if (!confirm(`Delete collection "${collection.name}"?`)) {
    return;
  }
  const result = await request(`/api/collections?id=${encodeURIComponent(collection.id)}`, {
    method: "DELETE"
  });
  app.state.collections = result.collections;
  app.activeCollectionId = result.collections[0]?.id || null;
  renderCollections();
  showToast("Collection deleted");
}

async function openCollectionInPane(collectionId = app.activeCollectionId, paneName = app.activePane) {
  const collection = (app.state?.collections || []).find((item) => item.id === collectionId) || currentCollection();
  if (!collection) {
    return showToast("Create a collection first");
  }
  const result = await request("/api/collections/resolve", {
    method: "POST",
    body: JSON.stringify({ collectionId: collection.id })
  });
  const tab = tabOf(paneName);
  tab.entries = result.entries;
  tab.selected = new Set();
  tab.focusedPath = null;
  tab.anchorPath = null;
  tab.searchMode = true;
  tab.virtualMode = "";
  tab.virtual = null;
  tab.title = `Collection: ${result.collection?.name || collection.name}`;
  tab.parent = null;
  renderPane(paneName);
  renderRoots();
  renderInspector();
  setStatus(`${result.available}/${result.total} collection items`);
}

function newCollection() {
  app.activeCollectionId = null;
  fillCollectionForm();
  renderCollectionItems(null);
}

function fileBasketItems() {
  if (!app.state) {
    return [];
  }
  if (!Array.isArray(app.state.fileBasket)) {
    app.state.fileBasket = [];
  }
  return app.state.fileBasket;
}

function uniqueBasketItems(items = []) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const source = typeof item === "string" ? { path: item } : item || {};
    if (!source.path) {
      continue;
    }
    const key = normalizedPathKey(source.path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({
      path: source.path,
      addedAt: source.addedAt || new Date().toISOString(),
      sourcePath: source.sourcePath || ""
    });
  }
  return unique.slice(0, 1000);
}

function basketPaths() {
  return fileBasketItems().map((item) => item.path);
}

function basketActionPaths() {
  const selected = app.fileBasket?.selected || new Set();
  const paths = basketPaths();
  const chosen = paths.filter((itemPath) => selected.has(itemPath));
  return chosen.length ? chosen : paths;
}

function basketSummaryText() {
  const count = fileBasketItems().length;
  const selected = app.fileBasket?.selected?.size || 0;
  return selected ? `${count} item(s) / ${selected} selected` : `${count} item(s)`;
}

function updateBasketButtons() {
  const count = fileBasketItems().length;
  const button = document.querySelector('[data-global-action="basket"]');
  if (button) {
    button.textContent = count ? `Basket ${count}` : "Basket";
    button.classList.toggle("active", count > 0);
    button.title = count ? `${count} basket item(s)` : "Open the file basket";
  }
}

function renderBasket() {
  updateBasketButtons();
  const summary = document.getElementById("basket-summary");
  if (summary) {
    summary.textContent = basketSummaryText();
  }
  const list = document.getElementById("basket-results");
  if (!list) {
    return;
  }
  const items = fileBasketItems();
  if (!items.length) {
    list.innerHTML = `<div class="empty-state">Basket is empty</div>`;
    return;
  }
  const selected = app.fileBasket?.selected || new Set();
  list.innerHTML = items
    .map((item) => {
      const checked = selected.has(item.path) ? " checked" : "";
      return `<div class="basket-row${checked ? " selected" : ""}">
        <input type="checkbox" data-basket-select="${escapeHtml(item.path)}"${checked} aria-label="Select ${escapeHtml(
          labelForPath(item.path)
        )}" />
        <span>
          <strong title="${escapeHtml(item.path)}">${escapeHtml(labelForPath(item.path))}</strong>
          <small>${escapeHtml(item.path)}</small>
        </span>
        <small>${escapeHtml(formatDate(item.addedAt))}</small>
        <button data-basket-remove="${escapeHtml(item.path)}">Remove</button>
      </div>`;
    })
    .join("");
}

async function saveBasketItems(items) {
  const nextItems = uniqueBasketItems(items);
  const validPaths = new Set(nextItems.map((item) => item.path));
  app.fileBasket.selected = new Set([...app.fileBasket.selected].filter((itemPath) => validPaths.has(itemPath)));
  app.state.fileBasket = nextItems;
  await saveStateNow();
  renderBasket();
  renderBackupDialog();
  return nextItems;
}

async function addPathsToBasket(paths, sourcePath = tabOf(app.activePane).path) {
  if (!paths.length) {
    return showToast("Select items first");
  }
  const addedAt = new Date().toISOString();
  const additions = paths.map((itemPath) => ({ path: itemPath, addedAt, sourcePath }));
  const existingCount = fileBasketItems().length;
  const nextItems = await saveBasketItems([...fileBasketItems(), ...additions]);
  showToast(`Basket: ${nextItems.length - existingCount} added / ${nextItems.length} total`);
  return nextItems;
}

async function addSelectionToBasket(paneName = app.activePane) {
  return addPathsToBasket(selectedPaths(paneName), tabOf(paneName).path);
}

async function openBasketDialog() {
  await loadState();
  renderBasket();
  document.getElementById("basket-dialog").showModal();
}

async function resolveBasketPaths(paths = basketActionPaths()) {
  if (!paths.length) {
    showToast("Basket is empty");
    return null;
  }
  return request("/api/collections/resolve", {
    method: "POST",
    body: JSON.stringify({ paths })
  });
}

async function openBasketInPane(paneName = app.activePane) {
  const result = await resolveBasketPaths();
  if (!result) {
    return;
  }
  const tab = tabOf(paneName);
  tab.entries = result.entries;
  tab.selected = new Set();
  tab.focusedPath = null;
  tab.anchorPath = null;
  tab.searchMode = true;
  tab.virtualMode = "";
  tab.virtual = null;
  tab.title = "Basket";
  tab.parent = null;
  renderPane(paneName);
  renderRoots();
  renderInspector();
  setStatus(`${result.available}/${result.total} basket items`);
}

async function copyBasketHere() {
  const paths = basketActionPaths();
  if (!paths.length) {
    return showToast("Basket is empty");
  }
  await request("/api/copy", {
    method: "POST",
    body: JSON.stringify({ paths, targetDir: tabOf(app.activePane).path })
  });
  await Promise.all([refreshPane("left"), refreshPane("right")]);
  await syncStateAndChrome();
  showToast(`Copied ${paths.length} basket item(s)`);
}

async function moveBasketHere() {
  const paths = basketActionPaths();
  if (!paths.length) {
    return showToast("Basket is empty");
  }
  await request("/api/move", {
    method: "POST",
    body: JSON.stringify({ paths, targetDir: tabOf(app.activePane).path })
  });
  const moving = new Set(paths.map(normalizedPathKey));
  await saveBasketItems(fileBasketItems().filter((item) => !moving.has(normalizedPathKey(item.path))));
  await Promise.all([refreshPane("left"), refreshPane("right")]);
  await syncStateAndChrome();
  showToast(`Moved ${paths.length} basket item(s)`);
}

function removeBasketPaths(paths) {
  const removing = new Set(paths.map(normalizedPathKey));
  return saveBasketItems(fileBasketItems().filter((item) => !removing.has(normalizedPathKey(item.path))));
}

async function removeSelectedBasketItems() {
  const selected = [...(app.fileBasket?.selected || new Set())];
  if (!selected.length) {
    return showToast("Select basket rows first");
  }
  await removeBasketPaths(selected);
  showToast(`Removed ${selected.length} basket item(s)`);
}

async function clearFileBasket() {
  if (!fileBasketItems().length) {
    return showToast("Basket is already empty");
  }
  if (!confirm("Clear the file basket?")) {
    return;
  }
  app.fileBasket.selected = new Set();
  await saveBasketItems([]);
  showToast("Basket cleared");
}

function archiveBasketItems() {
  const paths = basketActionPaths();
  if (!paths.length) {
    return showToast("Basket is empty");
  }
  openArchiveDialogForPaths(app.activePane, paths, { defaultName: "basket.zip" });
}

function defaultSnapshotName(paneName = app.activePane) {
  const stamp = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date());
  return `${paneName.toUpperCase()} Snapshot ${stamp}`;
}

function currentPaneSnapshot() {
  const snapshots = app.state?.paneSnapshots || [];
  return snapshots.find((snapshot) => snapshot.id === app.activePaneSnapshotId) || snapshots[0] || null;
}

function snapshotEntryForStorage(entry) {
  return {
    name: entry.name,
    path: entry.path,
    parent: entry.parent || parentPathOf(entry.path),
    extension: entry.extension || "",
    kind: entry.kind || (entry.isDirectory ? "Folder" : "File"),
    isDirectory: Boolean(entry.isDirectory),
    isFile: Boolean(entry.isFile),
    size: entry.size ?? null,
    fileCount: entry.fileCount ?? null,
    folderCount: entry.folderCount ?? null,
    folderSizeKnown: entry.folderSizeKnown === true,
    folderSizeStatus: entry.folderSizeStatus || "",
    folderSizeScannedAt: entry.folderSizeScannedAt || null,
    folderSizeTruncated: entry.folderSizeTruncated === true,
    modified: entry.modified || null,
    created: entry.created || null,
    accessed: entry.accessed || null,
    attributes: entry.attributes || null,
    attributeText: attributeText(entry),
    readonly: entry.readonly === true,
    hidden: entry.hidden === true,
    system: entry.system === true,
    archive: entry.archive === true,
    isSymlink: entry.isSymlink === true,
    linkType: entry.linkType || "",
    linkTarget: entry.linkTarget || "",
    linkTargetRaw: entry.linkTargetRaw || "",
    linkCount: entry.linkCount ?? null,
    unavailable: entry.unavailable === true
  };
}

function snapshotFromPane(paneName, existing = null, useFormValues = true) {
  const tab = tabOf(paneName);
  const now = new Date().toISOString();
  const formName = useFormValues ? document.getElementById("snapshot-name")?.value.trim() : "";
  const formDescription = useFormValues ? document.getElementById("snapshot-description")?.value.trim() : "";
  return {
    id: existing?.id || crypto.randomUUID(),
    name: formName || existing?.name || defaultSnapshotName(paneName),
    description: formDescription || existing?.description || "",
    sourcePane: paneName,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    path: tab.path,
    title: tab.title || labelForPath(tab.path),
    filter: tab.filter || "",
    kindFilter: normalizeKindFilter(tab.kindFilter),
    labelFilter: tab.labelFilter || "all",
    columns: normalizeColumns(tab.columns),
    columnWidths: normalizeColumnWidths(tab.columnWidths),
    sortKey: tab.sortKey,
    sortDir: tab.sortDir,
    viewMode: tab.viewMode,
    locked: tab.locked === true,
    selected: [...(tab.selected || new Set())],
    focusedPath: tab.focusedPath || null,
    entries: sortedEntries(tab).slice(0, 2000).map(snapshotEntryForStorage)
  };
}

function fillSnapshotForm(snapshot = null) {
  document.getElementById("snapshot-id").value = snapshot?.id || "";
  document.getElementById("snapshot-name").value = snapshot?.name || defaultSnapshotName();
  document.getElementById("snapshot-description").value = snapshot?.description || "";
}

function renderSnapshotItems(snapshot) {
  const list = document.getElementById("snapshot-items");
  if (!snapshot?.entries?.length) {
    list.innerHTML = `<div class="empty-state">No captured rows</div>`;
    return;
  }
  list.innerHTML = snapshot.entries
    .slice(0, 160)
    .map(
      (entry) =>
        `<div class="snapshot-item-row">
          <span>
            <strong title="${escapeHtml(entry.path)}">${escapeHtml(entry.name || labelForPath(entry.path))}</strong>
            <small>${escapeHtml(entry.path)}</small>
          </span>
          <small>${escapeHtml(entry.kind || "")}</small>
          <small>${formatSize(entry.size)}</small>
        </div>`
    )
    .join("");
}

function renderPaneSnapshots() {
  const list = document.getElementById("snapshot-list");
  if (!list) {
    return;
  }
  const snapshots = app.state?.paneSnapshots || [];
  if (!app.activePaneSnapshotId && snapshots[0]) {
    app.activePaneSnapshotId = snapshots[0].id;
  }
  if (app.activePaneSnapshotId && !snapshots.some((snapshot) => snapshot.id === app.activePaneSnapshotId)) {
    app.activePaneSnapshotId = snapshots[0]?.id || null;
  }
  const active = currentPaneSnapshot();
  document.getElementById("snapshot-summary").textContent = `${snapshots.length} saved`;
  list.innerHTML = snapshots.length
    ? snapshots
        .map(
          (snapshot) =>
            `<button class="${snapshot.id === active?.id ? "active" : ""}" data-select-snapshot="${escapeHtml(
              snapshot.id
            )}">
              <span>${escapeHtml(snapshot.name)}</span>
              <small>${snapshot.entries?.length || 0} rows / ${escapeHtml(labelForPath(snapshot.path))}</small>
            </button>`
        )
        .join("")
    : `<div class="empty-state">No snapshots</div>`;
  fillSnapshotForm(active);
  renderSnapshotItems(active);
}

async function openSnapshotsDialog() {
  await loadState();
  renderPaneSnapshots();
  document.getElementById("snapshots-dialog").showModal();
}

async function savePaneSnapshotFromForm() {
  const snapshotId = document.getElementById("snapshot-id").value;
  const existing = snapshotId
    ? (app.state?.paneSnapshots || []).find((snapshot) => snapshot.id === snapshotId)
    : null;
  const snapshot = snapshotFromPane(app.activePane, existing);
  app.state.paneSnapshots = [
    snapshot,
    ...(app.state?.paneSnapshots || []).filter((item) => item.id !== snapshot.id)
  ].slice(0, 50);
  app.activePaneSnapshotId = snapshot.id;
  await saveStateNow();
  renderPaneSnapshots();
  showToast("Snapshot saved");
}

async function quickSavePaneSnapshot(paneName) {
  const snapshot = snapshotFromPane(paneName, null, false);
  app.state.paneSnapshots = [
    snapshot,
    ...(app.state?.paneSnapshots || []).filter((item) => item.id !== snapshot.id)
  ].slice(0, 50);
  app.activePaneSnapshotId = snapshot.id;
  await saveStateNow();
  renderPaneSnapshots();
  showToast("Snapshot saved");
}

function newPaneSnapshot() {
  app.activePaneSnapshotId = null;
  fillSnapshotForm();
  renderSnapshotItems(null);
}

async function deleteActiveSnapshot() {
  const snapshot = currentPaneSnapshot();
  if (!snapshot) {
    return showToast("Select a snapshot first");
  }
  if (!confirm(`Delete snapshot "${snapshot.name}"?`)) {
    return;
  }
  app.state.paneSnapshots = (app.state.paneSnapshots || []).filter((item) => item.id !== snapshot.id);
  app.activePaneSnapshotId = null;
  await saveStateNow();
  renderPaneSnapshots();
  showToast("Snapshot deleted");
}

async function openSnapshotInPane(snapshotId = app.activePaneSnapshotId) {
  const snapshot = (app.state?.paneSnapshots || []).find((item) => item.id === snapshotId);
  if (!snapshot) {
    return showToast("Select a snapshot first");
  }
  const tab = tabOf(app.activePane);
  tab.path = snapshot.path;
  tab.parent = parentPathOf(snapshot.path);
  tab.title = `Snapshot: ${snapshot.name}`;
  tab.entries = (snapshot.entries || []).map((entry) => withCurrentLabel({ ...entry }));
  tab.searchMode = true;
  tab.virtualMode = "";
  tab.virtual = null;
  tab.folderSignature = null;
  tab.filter = snapshot.filter || "";
  tab.kindFilter = normalizeKindFilter(snapshot.kindFilter);
  tab.labelFilter = snapshot.labelFilter || "all";
  tab.columns = normalizeColumns(snapshot.columns);
  tab.sortKey = snapshot.sortKey || "name";
  tab.sortDir = snapshot.sortDir === "desc" ? "desc" : "asc";
  tab.viewMode = ["details", "compact", "tiles"].includes(snapshot.viewMode) ? snapshot.viewMode : "details";
  tab.locked = snapshot.locked === true;
  const entryPaths = new Set(tab.entries.map((entry) => entry.path));
  tab.selected = new Set((snapshot.selected || []).filter((itemPath) => entryPaths.has(itemPath)));
  tab.focusedPath = entryPaths.has(snapshot.focusedPath) ? snapshot.focusedPath : [...tab.selected][0] || null;
  tab.anchorPath = tab.focusedPath;
  renderPane(app.activePane);
  renderRoots();
  updateSelectionReadout();
  renderInspector();
  scheduleStateSave();
  document.getElementById("snapshots-dialog").close();
  setStatus(`Snapshot: ${snapshot.entries?.length || 0} row(s)`);
}

function columnDescription(column) {
  if (column.id === "parent") {
    return "Folder path";
  }
  if (column.id === "linkType") {
    return "Hardlink or symlink";
  }
  if (column.id === "linkTarget") {
    return "Symlink target";
  }
  if (column.id === "notes") {
    return "Label notes";
  }
  return column.sortKey;
}

function renderColumnsDialog() {
  const list = document.getElementById("column-choice-list");
  if (!list) {
    return;
  }
  const tab = tabOf(app.activePane);
  const activeColumns = new Set(normalizeColumns(tab.columns));
  const widthCount = Object.keys(normalizeColumnWidths(tab.columnWidths)).length;
  document.getElementById("column-summary").textContent = `${activeColumns.size} columns / ${widthCount} widths`;
  const presetStrip = document.getElementById("column-preset-strip");
  if (presetStrip) {
    presetStrip.innerHTML = columnPresetDefinitions
      .map(
        (preset) =>
          `<button type="button" data-column-preset="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</button>`
      )
      .join("");
  }
  list.innerHTML = detailColumnDefs
    .map(
      (column) =>
        `<label class="column-choice">
          <input data-column-choice="${escapeHtml(column.id)}" type="checkbox" ${
            activeColumns.has(column.id) ? "checked" : ""
          } ${column.required ? "disabled" : ""} />
          <span>
            <strong>${escapeHtml(column.title)}</strong>
            <small>${escapeHtml(columnDescription(column))}</small>
          </span>
        </label>`
    )
    .join("");
}

async function openColumnsDialog(paneName = app.activePane) {
  app.activePane = paneName;
  updateActivePaneChrome();
  renderColumnsDialog();
  document.getElementById("columns-dialog").showModal();
}

function selectedColumnIdsFromDialog() {
  const selected = [...document.querySelectorAll("[data-column-choice]:checked")].map(
    (input) => input.dataset.columnChoice
  );
  return normalizeColumns(selected);
}

async function applyColumnsFromDialog(columns = selectedColumnIdsFromDialog()) {
  const tab = tabOf(app.activePane);
  tab.columns = normalizeColumns(columns);
  const visibleSorts = new Set(columnsForTab(tab).map((column) => column.sortKey));
  if (!visibleSorts.has(tab.sortKey)) {
    tab.sortKey = "name";
    tab.sortDir = "asc";
  }
  if (tabNeedsUnloadedMetadata(tab)) {
    await refreshPane(app.activePane, { preserveSelection: true, save: false, silent: true });
  } else {
    renderPane(app.activePane);
  }
  scheduleStateSave();
  renderColumnsDialog();
  showToast("Columns updated");
}

function defaultFormatName(itemPath = tabOf(app.activePane).path) {
  return `${labelForPath(itemPath)} Format`;
}

function currentFolderFormat() {
  const formats = app.state?.folderFormats || [];
  return formats.find((format) => format.id === app.activeFolderFormatId) || formats[0] || null;
}

function formatSummaryText(format) {
  if (!format?.format) {
    return "";
  }
  return displaySnapshotSummary(format.format);
}

function fillFormatForm(format = null) {
  const tab = tabOf(app.activePane);
  document.getElementById("format-id").value = format?.id || "";
  document.getElementById("format-name").value = format?.name || defaultFormatName(tab.path);
  document.getElementById("format-path").value = format?.path || tab.path;
  document.getElementById("format-match").value = format?.match || "exact";
  document.getElementById("format-description").value = format?.description || "";
  document.getElementById("format-capture-summary").textContent = `Captures ${displaySnapshotSummary(
    folderFormatSnapshot(tab)
  )}`;
}

function renderFolderFormats() {
  const list = document.getElementById("format-list");
  if (!list) {
    return;
  }
  const formats = app.state?.folderFormats || [];
  if (!app.activeFolderFormatId && formats[0]) {
    app.activeFolderFormatId = formats[0].id;
  }
  const active = currentFolderFormat();
  document.getElementById("format-summary").textContent = `${formats.length} saved`;
  list.innerHTML = formats.length
    ? formats
        .map(
          (format) =>
            `<button class="${format.id === active?.id ? "active" : ""}" data-select-format="${escapeHtml(
              format.id
            )}">
              <span>
                <strong>${escapeHtml(format.name)}</strong>
                <small>${escapeHtml(format.match)} / ${escapeHtml(format.path)}</small>
                <small>${escapeHtml(formatSummaryText(format))}</small>
              </span>
            </button>`
        )
        .join("")
    : `<div class="empty-state">No folder formats</div>`;
  fillFormatForm(active);
}

async function openFormatsDialog(paneName = app.activePane) {
  app.activePane = paneName;
  await loadState();
  renderFolderFormats();
  renderDisplayPresets();
  document.getElementById("formats-dialog").showModal();
}

function formatFromForm() {
  const id = document.getElementById("format-id").value || crypto.randomUUID();
  return {
    id,
    name: document.getElementById("format-name").value.trim() || defaultFormatName(),
    path: document.getElementById("format-path").value.trim() || tabOf(app.activePane).path,
    match: document.getElementById("format-match").value === "subtree" ? "subtree" : "exact",
    description: document.getElementById("format-description").value.trim(),
    updatedAt: new Date().toISOString(),
    format: folderFormatSnapshot()
  };
}

async function persistFolderFormat(format) {
  const existing = (app.state.folderFormats || []).find((item) => item.id === format.id);
  const saved = {
    ...existing,
    ...format,
    createdAt: existing?.createdAt || new Date().toISOString()
  };
  app.state.folderFormats = [
    saved,
    ...(app.state.folderFormats || []).filter((item) => item.id !== saved.id)
  ].slice(0, 50);
  app.activeFolderFormatId = saved.id;
  await saveStateNow();
  renderFolderFormats();
  return saved;
}

async function saveCurrentFolderFormat() {
  const tab = tabOf(app.activePane);
  const existing = (app.state.folderFormats || []).find(
    (item) => item.match === "exact" && samePath(item.path, tab.path)
  );
  const saved = await persistFolderFormat({
    id: existing?.id || crypto.randomUUID(),
    name: existing?.name || defaultFormatName(tab.path),
    path: tab.path,
    match: "exact",
    description: existing?.description || "",
    updatedAt: new Date().toISOString(),
    format: folderFormatSnapshot(tab)
  });
  showToast(`Saved ${saved.name}`);
  return saved;
}

async function saveFolderFormatFromForm() {
  const saved = await persistFolderFormat(formatFromForm());
  showToast("Folder format saved");
  return saved;
}

async function applyActiveFolderFormat() {
  const format = currentFolderFormat();
  if (!format) {
    return showToast("Create a format first");
  }
  const tab = tabOf(app.activePane);
  applyFormatToTab(tab, format);
  if (tabNeedsUnloadedMetadata(tab)) {
    await refreshPane(app.activePane, { preserveSelection: true, save: false, silent: true });
  } else {
    renderPane(app.activePane);
  }
  scheduleStateSave();
  showToast(`Applied ${format.name}`);
}

async function deleteActiveFolderFormat() {
  const format = currentFolderFormat();
  if (!format) {
    return;
  }
  if (!confirm(`Delete folder format "${format.name}"?`)) {
    return;
  }
  app.state.folderFormats = (app.state.folderFormats || []).filter((item) => item.id !== format.id);
  app.activeFolderFormatId = app.state.folderFormats[0]?.id || null;
  await saveStateNow();
  renderFolderFormats();
  showToast("Folder format deleted");
}

function newFolderFormat() {
  app.activeFolderFormatId = null;
  fillFormatForm();
}

function defaultDisplayPresetName(tab = tabOf(app.activePane)) {
  const view = tab.viewMode === "tiles" ? "Tiles" : tab.viewMode === "compact" ? "Compact" : "Details";
  return `${view} ${tab.sortKey || "Name"} Preset`;
}

function displayPresets() {
  if (!app.state) {
    return [];
  }
  if (!Array.isArray(app.state.displayPresets)) {
    app.state.displayPresets = [];
  }
  return app.state.displayPresets;
}

function currentDisplayPreset() {
  const presets = displayPresets();
  return presets.find((preset) => preset.id === app.activeDisplayPresetId) || presets[0] || null;
}

function fillDisplayPresetForm(preset = null) {
  const tab = tabOf(app.activePane);
  document.getElementById("display-preset-id").value = preset?.id || "";
  document.getElementById("display-preset-name").value = preset?.name || defaultDisplayPresetName(tab);
  document.getElementById("display-preset-description").value = preset?.description || "";
  document.getElementById("display-preset-capture-summary").textContent = `Captures ${displaySnapshotSummary(
    folderFormatSnapshot(tab)
  )}`;
}

function renderDisplayPresets() {
  const list = document.getElementById("display-preset-list");
  if (!list) {
    return;
  }
  const presets = displayPresets();
  if (!app.activeDisplayPresetId && presets[0]) {
    app.activeDisplayPresetId = presets[0].id;
  }
  const active = currentDisplayPreset();
  document.getElementById("display-preset-summary").textContent = `${presets.length} saved`;
  list.innerHTML = presets.length
    ? presets
        .map(
          (preset) =>
            `<button class="${preset.id === active?.id ? "active" : ""}" data-select-display-preset="${escapeHtml(
              preset.id
            )}">
              <span>
                <strong>${escapeHtml(preset.name)}</strong>
                ${preset.description ? `<small>${escapeHtml(preset.description)}</small>` : ""}
                <small>${escapeHtml(displaySnapshotSummary(preset.format))}</small>
              </span>
            </button>`
        )
        .join("")
    : `<div class="empty-state">No display presets</div>`;
  fillDisplayPresetForm(active);
}

function displayPresetFromForm() {
  const id = document.getElementById("display-preset-id").value || crypto.randomUUID();
  return {
    id,
    name: document.getElementById("display-preset-name").value.trim() || defaultDisplayPresetName(),
    description: document.getElementById("display-preset-description").value.trim(),
    updatedAt: new Date().toISOString(),
    format: folderFormatSnapshot()
  };
}

async function persistDisplayPreset(preset) {
  const existing = displayPresets().find((item) => item.id === preset.id);
  const saved = {
    ...existing,
    ...preset,
    createdAt: existing?.createdAt || new Date().toISOString()
  };
  app.state.displayPresets = [
    saved,
    ...displayPresets().filter((item) => item.id !== saved.id)
  ].slice(0, 50);
  app.activeDisplayPresetId = saved.id;
  await saveStateNow();
  renderDisplayPresets();
  renderBackupDialog();
  return saved;
}

async function saveDisplayPresetFromForm() {
  const saved = await persistDisplayPreset(displayPresetFromForm());
  showToast(`Preset saved: ${saved.name}`);
  return saved;
}

async function quickSaveDisplayPreset() {
  await loadState();
  const saved = await persistDisplayPreset({
    id: crypto.randomUUID(),
    name: defaultDisplayPresetName(),
    description: "",
    updatedAt: new Date().toISOString(),
    format: folderFormatSnapshot()
  });
  showToast(`Preset saved: ${saved.name}`);
  return saved;
}

async function applyActiveDisplayPreset() {
  const preset = currentDisplayPreset();
  if (!preset) {
    return showToast("Create a preset first");
  }
  const tab = tabOf(app.activePane);
  applyDisplaySnapshotToTab(tab, preset.format);
  if (tabNeedsUnloadedMetadata(tab)) {
    await refreshPane(app.activePane, { preserveSelection: true, save: false, silent: true });
  } else {
    renderPane(app.activePane);
  }
  scheduleStateSave();
  renderColumnsDialog();
  renderFolderFormats();
  renderDisplayPresets();
  showToast(`Applied ${preset.name}`);
}

async function deleteActiveDisplayPreset() {
  const preset = currentDisplayPreset();
  if (!preset) {
    return;
  }
  if (!confirm(`Delete display preset "${preset.name}"?`)) {
    return;
  }
  app.state.displayPresets = displayPresets().filter((item) => item.id !== preset.id);
  app.activeDisplayPresetId = app.state.displayPresets[0]?.id || null;
  await saveStateNow();
  renderDisplayPresets();
  renderBackupDialog();
  showToast("Display preset deleted");
}

function newDisplayPreset() {
  app.activeDisplayPresetId = null;
  fillDisplayPresetForm();
}

async function openDisplayPresetsDialog(paneName = app.activePane) {
  await openFormatsDialog(paneName);
  document.getElementById("display-preset-name")?.focus();
}

function labelTargets() {
  return selectedPaths(app.activePane);
}

function targetLabelSeed(paths) {
  const labels = paths.map(pathLabelFor).filter(Boolean);
  return labels[0] || { name: "Marked", color: app.lastLabelColor || "teal", notes: "" };
}

function fillLabelForm() {
  const paths = labelTargets();
  const seed = targetLabelSeed(paths);
  document.getElementById("label-target-summary").textContent = paths.length
    ? `${paths.length} selected`
    : "No selection";
  document.getElementById("label-name").value = seed.name || "Marked";
  document.getElementById("label-notes").value = seed.notes || "";
  const color = labelColors.some((item) => item.id === seed.color) ? seed.color : "teal";
  document.querySelectorAll("[name='label-color']").forEach((input) => {
    input.checked = input.value === color;
  });
}

function renderLabelsDialog() {
  const list = document.getElementById("label-existing-list");
  if (!list) {
    return;
  }
  const labels = app.state?.labels || [];
  document.getElementById("label-summary").textContent = `${labels.length} labeled`;
  list.innerHTML = labels.length
    ? labels
        .map(
          (label) =>
            `<div class="label-row">
              <span>
                ${labelBadgeMarkup(label)}
                <strong title="${escapeHtml(label.path)}">${escapeHtml(labelForPath(label.path))}</strong>
                <small>${escapeHtml(label.path)}</small>
                ${label.notes ? `<small>${escapeHtml(label.notes)}</small>` : ""}
              </span>
              <button data-label-show="${escapeHtml(label.path)}">Show</button>
            </div>`
        )
        .join("")
    : `<div class="empty-state">No labels</div>`;
  fillLabelForm();
}

async function openLabelsDialog(paneName = app.activePane) {
  app.activePane = paneName;
  await loadState();
  refreshOpenEntryLabels();
  renderAll();
  renderLabelsDialog();
  document.getElementById("labels-dialog").showModal();
}

function labelPayloadFromForm() {
  const checkedColor = document.querySelector("[name='label-color']:checked");
  const color = checkedColor?.value || app.lastLabelColor || "teal";
  app.lastLabelColor = color;
  return {
    paths: labelTargets(),
    name: document.getElementById("label-name").value.trim() || "Marked",
    color,
    notes: document.getElementById("label-notes").value.trim()
  };
}

async function applyLabelFromForm() {
  const payload = labelPayloadFromForm();
  if (!payload.paths.length) {
    return showToast("Select items first");
  }
  const result = await request("/api/labels/apply", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  app.state.labels = result.labels;
  refreshOpenEntryLabels();
  renderAll();
  renderLabelsDialog();
  renderInspector();
  showToast(`Labeled ${result.applied.length} item(s)`);
}

async function clearLabelsFromSelection() {
  const paths = labelTargets();
  if (!paths.length) {
    return showToast("Select labeled items first");
  }
  const result = await request("/api/labels/clear", {
    method: "POST",
    body: JSON.stringify({ paths })
  });
  app.state.labels = result.labels;
  refreshOpenEntryLabels();
  renderAll();
  renderLabelsDialog();
  renderInspector();
  showToast(`Cleared ${result.cleared.length} item(s)`);
}

async function showLabeledPath(itemPath) {
  const targetDir = itemPath ? itemPath.replace(/[\\/][^\\/]*$/, "") : null;
  if (!targetDir) {
    return;
  }
  await loadPane(app.activePane, targetDir);
  const tab = tabOf(app.activePane);
  tab.selected = new Set([itemPath]);
  tab.focusedPath = itemPath;
  tab.anchorPath = itemPath;
  commitSelectionChange(app.activePane);
}

function layoutPaneText(layout, paneName) {
  const pane = layout?.panes?.[paneName] || {};
  const tabs = Array.isArray(pane.tabs) && pane.tabs.length ? pane.tabs : [];
  const active = tabs[Math.max(0, Math.min(Number(pane.activeTab || 0), tabs.length - 1))] || tabs[0];
  return active?.path ? `${paneName}: ${labelForPath(active.path)}` : `${paneName}: empty`;
}

function layoutTabCount(layout) {
  return ["left", "right"].reduce((count, paneName) => {
    const tabs = layout?.panes?.[paneName]?.tabs;
    return count + (Array.isArray(tabs) ? tabs.length : 0);
  }, 0);
}

function defaultLayoutName() {
  const now = new Date();
  const stamp = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(now);
  return `Workspace ${stamp}`;
}

function fillLayoutForm(layout = null) {
  document.getElementById("layout-id").value = layout?.id || "";
  document.getElementById("layout-name").value = layout?.name || defaultLayoutName();
  document.getElementById("layout-description").value = layout?.description || "";
}

function renderLayouts() {
  const layouts = app.state?.layouts || [];
  const settings = currentSettings();
  const list = document.getElementById("layout-list");
  document.getElementById("layout-summary").textContent = `${layouts.length} saved`;
  list.innerHTML = layouts.length
    ? layouts
        .map(
          (layout) => {
            const isStartupLayout =
              settings.startupMode === "savedLayout" && settings.startupLayoutId === layout.id;
            return `<div class="layout-row${isStartupLayout ? " selected" : ""}">
              <div>
                <strong>${escapeHtml(layout.name)}</strong>
                <small>${escapeHtml(
                  isStartupLayout
                    ? `Startup / ${layout.description || `${layoutTabCount(layout.layout)} tabs`}`
                    : layout.description || `${layoutTabCount(layout.layout)} tabs`
                )}</small>
              </div>
              <div class="layout-paths">
                <span title="${escapeHtml(layout.layout?.panes?.left?.tabs?.[0]?.path || "")}">${escapeHtml(
                  layoutPaneText(layout.layout, "left")
                )}</span>
                <span title="${escapeHtml(layout.layout?.panes?.right?.tabs?.[0]?.path || "")}">${escapeHtml(
                  layoutPaneText(layout.layout, "right")
                )}</span>
              </div>
              <small>${escapeHtml(formatDate(layout.updatedAt))}</small>
              <div class="layout-actions">
                <button data-layout-startup="${escapeHtml(layout.id)}">${
                  isStartupLayout ? "Startup" : "Make Startup"
                }</button>
                <button data-layout-restore="${escapeHtml(layout.id)}">Restore</button>
                <button data-layout-replace="${escapeHtml(layout.id)}">Replace</button>
                <button data-layout-delete="${escapeHtml(layout.id)}">Delete</button>
              </div>
            </div>`;
          }
        )
        .join("")
    : `<div class="empty-state">No saved layouts</div>`;
}

async function openLayoutsDialog() {
  await loadState();
  fillLayoutForm();
  renderLayouts();
  document.getElementById("layouts-dialog").showModal();
}

async function saveCurrentLayoutFromForm() {
  const layoutId = document.getElementById("layout-id").value;
  const name = document.getElementById("layout-name").value.trim() || defaultLayoutName();
  const description = document.getElementById("layout-description").value.trim();
  const result = await request("/api/layouts", {
    method: "POST",
    body: JSON.stringify({
      id: layoutId || undefined,
      name,
      description,
      layout: serializeLayout()
    })
  });
  app.state.layouts = result.layouts;
  fillLayoutForm(result.layout);
  renderLayouts();
  renderPreferencesDialog();
  showToast("Layout saved");
}

async function makeSavedLayoutStartup(layoutId) {
  const layout = (app.state?.layouts || []).find((item) => item.id === layoutId);
  if (!layout) {
    return showToast("Layout not found");
  }
  await saveSettingsPatch(
    { startupMode: "savedLayout", startupLayoutId: layout.id },
    { message: `${layout.name} set as startup` }
  );
  renderLayouts();
}

async function replaceSavedLayout(layoutId) {
  const layout = (app.state?.layouts || []).find((item) => item.id === layoutId);
  if (!layout) {
    return showToast("Layout not found");
  }
  document.getElementById("layout-id").value = layout.id;
  document.getElementById("layout-name").value = layout.name;
  document.getElementById("layout-description").value = layout.description || "";
  await saveCurrentLayoutFromForm();
}

async function deleteSavedLayout(layoutId) {
  const layout = (app.state?.layouts || []).find((item) => item.id === layoutId);
  if (!layout) {
    return showToast("Layout not found");
  }
  if (!confirm(`Delete layout "${layout.name}"?`)) {
    return;
  }
  const result = await request(`/api/layouts?id=${encodeURIComponent(layoutId)}`, {
    method: "DELETE"
  });
  app.state.layouts = result.layouts;
  if (result.settings) {
    app.state.settings = result.settings;
  }
  fillLayoutForm();
  renderLayouts();
  renderPreferencesDialog();
  showToast("Layout deleted");
}

async function restoreSavedLayout(layoutId) {
  const layout = (app.state?.layouts || []).find((item) => item.id === layoutId);
  if (!layout) {
    return showToast("Layout not found");
  }
  app.state.layout = layout.layout;
  hydratePanesFromLayout(layout.layout);
  await Promise.all([
    loadPane("left", tabOf("left").path || app.roots.cwd, false),
    loadPane("right", tabOf("right").path || app.roots.home, false)
  ]);
  renderRoots();
  renderAll();
  renderInspector();
  await saveStateNow();
  document.getElementById("layouts-dialog").close();
  showToast(`Restored ${layout.name}`);
}

function tabGroupTabCount(group) {
  return Array.isArray(group?.tabs) ? group.tabs.length : 0;
}

function tabGroupActiveText(group) {
  const tabs = Array.isArray(group?.tabs) ? group.tabs : [];
  const active = tabs[Math.max(0, Math.min(Number(group?.activeTab || 0), tabs.length - 1))] || tabs[0];
  return active?.path ? labelForPath(active.path) : "empty";
}

function defaultTabGroupName() {
  const now = new Date();
  const stamp = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(now);
  return `${app.activePane.toUpperCase()} Tabs ${stamp}`;
}

function fillTabGroupForm(group = null) {
  document.getElementById("tab-group-id").value = group?.id || "";
  document.getElementById("tab-group-name").value = group?.name || defaultTabGroupName();
  document.getElementById("tab-group-description").value = group?.description || "";
}

function activeTabGroup() {
  return (app.state?.tabGroups || []).find((group) => group.id === app.activeTabGroupId) || null;
}

function renderTabGroups() {
  const groups = app.state?.tabGroups || [];
  const list = document.getElementById("tab-group-list");
  if (!list) {
    return;
  }
  if (app.activeTabGroupId && !groups.some((group) => group.id === app.activeTabGroupId)) {
    app.activeTabGroupId = null;
  }
  document.getElementById("tab-group-summary").textContent = `${groups.length} saved`;
  list.innerHTML = groups.length
    ? groups
        .map((group) => {
          const selected = group.id === app.activeTabGroupId ? " selected" : "";
          return `<div class="tab-group-row${selected}">
            <div>
              <strong>${escapeHtml(group.name)}</strong>
              <small>${escapeHtml(group.description || `${tabGroupTabCount(group)} tabs`)}</small>
            </div>
            <div class="tab-group-paths">
              <span title="${escapeHtml(group.tabs?.[0]?.path || "")}">${escapeHtml(tabGroupActiveText(group))}</span>
              <small>${escapeHtml((group.sourcePane || "left").toUpperCase())} / ${tabGroupTabCount(group)} tab(s)</small>
            </div>
            <small>${escapeHtml(formatDate(group.updatedAt))}</small>
            <div class="tab-group-actions">
              <button data-tab-group-restore="${escapeHtml(group.id)}">Restore</button>
              <button data-tab-group-replace="${escapeHtml(group.id)}">Replace</button>
              <button data-tab-group-delete="${escapeHtml(group.id)}">Delete</button>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="empty-state">No saved tab groups</div>`;
  fillTabGroupForm(activeTabGroup());
}

async function openTabGroupsDialog() {
  await loadState();
  fillTabGroupForm();
  renderTabGroups();
  document.getElementById("tab-groups-dialog").showModal();
}

async function saveCurrentTabGroupFromForm() {
  const groupId = document.getElementById("tab-group-id").value || crypto.randomUUID();
  const existing = (app.state?.tabGroups || []).find((group) => group.id === groupId);
  const now = new Date().toISOString();
  const snapshot = serializePaneTabs(app.activePane);
  const group = {
    id: groupId,
    name: document.getElementById("tab-group-name").value.trim() || defaultTabGroupName(),
    description: document.getElementById("tab-group-description").value.trim(),
    sourcePane: app.activePane,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    activeTab: snapshot.activeTab,
    tabs: snapshot.tabs
  };
  app.state.tabGroups = [
    group,
    ...(app.state?.tabGroups || []).filter((item) => item.id !== group.id)
  ].slice(0, 50);
  app.activeTabGroupId = group.id;
  await saveStateNow();
  renderTabGroups();
  showToast("Tab group saved");
}

async function replaceSavedTabGroup(groupId) {
  const group = (app.state?.tabGroups || []).find((item) => item.id === groupId);
  if (!group) {
    return showToast("Tab group not found");
  }
  document.getElementById("tab-group-id").value = group.id;
  document.getElementById("tab-group-name").value = group.name;
  document.getElementById("tab-group-description").value = group.description || "";
  await saveCurrentTabGroupFromForm();
}

async function deleteSavedTabGroup(groupId) {
  const group = (app.state?.tabGroups || []).find((item) => item.id === groupId);
  if (!group) {
    return showToast("Tab group not found");
  }
  if (!confirm(`Delete tab group "${group.name}"?`)) {
    return;
  }
  app.state.tabGroups = (app.state.tabGroups || []).filter((item) => item.id !== groupId);
  app.activeTabGroupId = null;
  await saveStateNow();
  fillTabGroupForm();
  renderTabGroups();
  showToast("Tab group deleted");
}

async function restoreSavedTabGroup(groupId) {
  const group = (app.state?.tabGroups || []).find((item) => item.id === groupId);
  if (!group || !Array.isArray(group.tabs) || !group.tabs.length) {
    return showToast("Tab group not found");
  }
  const paneName = app.activePane;
  panes[paneName].tabs = group.tabs.map((savedTab) => normalizeSavedTab(savedTab, savedTab.path || app.roots.cwd));
  panes[paneName].activeTab = Math.max(0, Math.min(Number(group.activeTab || 0), panes[paneName].tabs.length - 1));
  const active = tabOf(paneName);
  await loadPane(paneName, active.path || app.roots.cwd, false, {
    allowLockedNavigation: true,
    linkedFollow: true,
    save: false
  });
  renderRoots();
  renderAll();
  renderInspector();
  await saveStateNow();
  document.getElementById("tab-groups-dialog").close();
  showToast(`Restored ${group.name}`);
}

async function saveToolFromForm() {
  const tool = toolFromForm();
  const commands = app.state.commands || [];
  const index = commands.findIndex((command) => command.id === tool.id);
  if (index === -1) {
    commands.push(tool);
  } else {
    commands[index] = tool;
  }
  app.state.commands = commands;
  app.activeToolId = tool.id;
  await saveStateNow();
  renderToolManager();
  showToast("Tool saved");
}

async function deleteActiveTool() {
  const tool = currentTool();
  if (!tool) {
    return;
  }
  const ok = confirm(`Delete ${tool.name}?`);
  if (!ok) {
    return;
  }
  app.state.commands = (app.state.commands || []).filter((command) => command.id !== tool.id);
  app.activeToolId = app.state.commands[0]?.id || null;
  await saveStateNow();
  renderToolManager();
  showToast("Tool deleted");
}

function newTool() {
  app.activeToolId = null;
  fillToolForm({
    id: "",
    name: "New Tool",
    kind: "powershell",
    description: "",
    showInToolbar: true,
    command: "Write-Output \"Active: $env:EB_ACTIVE\""
  });
}

function insertToolToken(token) {
  const textarea = document.getElementById("tool-command");
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.value = `${textarea.value.slice(0, start)}${token}${textarea.value.slice(end)}`;
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = start + token.length;
}

async function runTool(commandId = null) {
  const savedTool = commandId
    ? (app.state?.commands || []).find((command) => command.id === commandId)
    : null;
  const tool = savedTool || toolFromForm();
  if (!tool) {
    return showToast("Select a tool first");
  }
  const output = document.getElementById("tool-output");
  if (output) {
    output.textContent = "Running...";
  }
  let result;
  try {
    result = await request("/api/command/run", {
      method: "POST",
      body: JSON.stringify({
        ...(savedTool ? { commandId: savedTool.id } : { command: tool }),
        ...commandContext()
      })
    });
  } catch (error) {
    await syncStateAndChrome();
    if (output) {
      output.textContent = error.message;
    }
    throw error;
  }
  const text = [
    `Exit ${result.exitCode}`,
    result.stdout ? `\n${result.stdout}` : "",
    result.stderr ? `\nERR:\n${result.stderr}` : ""
  ].join("");
  if (output) {
    output.textContent = text;
  }
  await syncStateAndChrome();
  showToast("Tool complete");
}

function favorites() {
  if (!app.state) {
    app.state = {};
  }
  if (!Array.isArray(app.state.favorites)) {
    app.state.favorites = [];
  }
  return app.state.favorites;
}

function currentFavorite() {
  return favorites().find((item) => item.id === app.activeFavoriteId) || favorites()[0] || null;
}

function favoriteDraftForActivePane(paneName = app.activePane) {
  const tab = tabOf(paneName);
  return {
    id: "",
    name: tab.title || labelForPath(tab.path) || "Favorite",
    path: tab.path || "",
    color: "gold"
  };
}

function favoriteDraftFromForm() {
  return {
    id: document.getElementById("favorite-id")?.value || "",
    name: document.getElementById("favorite-name")?.value.trim() || "",
    path: document.getElementById("favorite-path")?.value.trim() || "",
    color: favoriteColor(document.querySelector("[name='favorite-color']:checked")?.value)
  };
}

function fillFavoriteForm(favorite = null) {
  const draft = favorite || favoriteDraftForActivePane(app.activePane);
  document.getElementById("favorite-id").value = draft.id || "";
  document.getElementById("favorite-name").value = draft.name || labelForPath(draft.path) || "Favorite";
  document.getElementById("favorite-path").value = draft.path || "";
  const color = favoriteColor(draft.color);
  document.querySelectorAll("[name='favorite-color']").forEach((input) => {
    input.checked = input.value === color;
  });
  renderFavoritePreview();
}

function renderFavoritePreview() {
  const preview = document.getElementById("favorite-preview");
  if (!preview) {
    return;
  }
  const favorite = favoriteDraftFromForm();
  const colorClass = favoriteColorClass(favorite.color);
  preview.className = `favorite-preview ${colorClass}`;
  preview.innerHTML = `<span class="nav-code">FAV</span>
    <span>
      <strong>${escapeHtml(favorite.name || "Favorite")}</strong>
      <small>${escapeHtml(favorite.path || "No path set")}</small>
    </span>`;
}

function renderFavoritesDialog() {
  const list = document.getElementById("favorite-list");
  if (!list) {
    return;
  }
  const items = favorites();
  if (app.activeFavoriteId && !items.some((item) => item.id === app.activeFavoriteId)) {
    app.activeFavoriteId = items[0]?.id || null;
  }
  if (!app.activeFavoriteId && items[0]) {
    app.activeFavoriteId = items[0].id;
  }
  const active = currentFavorite();
  const summary = document.getElementById("favorite-summary");
  if (summary) {
    summary.textContent = `${items.length} saved`;
  }
  list.innerHTML = items.length
    ? items
        .map(
          (favorite, index) =>
            `<button class="${favorite.id === active?.id ? "active" : ""} ${favoriteColorClass(
              favorite.color
            )}" data-select-favorite="${escapeHtml(favorite.id)}">
              <span class="nav-code">FAV</span>
              <span>
                <strong>${escapeHtml(favorite.name || labelForPath(favorite.path))}</strong>
                <small>${escapeHtml(favorite.path)}</small>
              </span>
              <small>${index + 1}</small>
            </button>`
        )
        .join("")
    : `<div class="empty-state">No favorites yet</div>`;
  fillFavoriteForm(active);
}

async function persistFavorites(nextFavorites, activeId = app.activeFavoriteId) {
  app.state.favorites = nextFavorites.slice(0, 100);
  app.activeFavoriteId = activeId || app.state.favorites[0]?.id || null;
  await saveStateNow();
  renderRoots();
  renderFavoritesDialog();
  renderBackupDialog();
}

async function saveFavoriteFromForm() {
  const draft = favoriteDraftFromForm();
  if (!draft.name || !draft.path) {
    return showToast("Favorite needs a name and path");
  }
  const id = draft.id || crypto.randomUUID();
  const favorite = {
    id,
    name: draft.name,
    path: draft.path,
    color: favoriteColor(draft.color)
  };
  const currentItems = favorites();
  const oldIndex = currentItems.findIndex((item) => item.id === id);
  const duplicateIndex = currentItems.findIndex((item) => samePath(item.path, favorite.path) && item.id !== id);
  const removeIds = new Set([id]);
  if (duplicateIndex !== -1) {
    removeIds.add(currentItems[duplicateIndex].id);
  }
  const nextItems = currentItems.filter((item) => !removeIds.has(item.id));
  const rawIndex = oldIndex !== -1 ? oldIndex : duplicateIndex !== -1 ? duplicateIndex : nextItems.length;
  const insertIndex = Math.max(0, Math.min(rawIndex, nextItems.length));
  nextItems.splice(insertIndex, 0, favorite);
  await persistFavorites(nextItems, favorite.id);
  showToast(`Favorite saved: ${favorite.name}`);
  return favorite;
}

function newFavorite() {
  app.activeFavoriteId = null;
  fillFavoriteForm(favoriteDraftForActivePane(app.activePane));
  document.getElementById("favorite-name")?.focus();
}

async function addFavorite(paneName) {
  const tab = tabOf(paneName);
  if (!tab.path) {
    return showToast("No active path");
  }
  const currentItems = favorites();
  const existing = currentItems.find((favorite) => samePath(favorite.path, tab.path));
  if (existing) {
    app.activeFavoriteId = existing.id;
    renderFavoritesDialog();
    return showToast(`${existing.name} is already a favorite`);
  }
  const favorite = {
    id: crypto.randomUUID(),
    name: tab.title || labelForPath(tab.path),
    path: tab.path,
    color: "gold"
  };
  await persistFavorites([...currentItems, favorite], favorite.id);
  showToast(`Favorite saved: ${favorite.name}`);
  return favorite;
}

async function addActiveFavoriteFromManager() {
  const favorite = await addFavorite(app.activePane);
  if (favorite) {
    fillFavoriteForm(favorite);
  }
}

async function removeFavorite(favoriteId) {
  const favorite = favorites().find((item) => item.id === favoriteId);
  if (!favorite) {
    return;
  }
  const nextItems = favorites().filter((item) => item.id !== favoriteId);
  const nextActive = app.activeFavoriteId === favoriteId ? nextItems[0]?.id || null : app.activeFavoriteId;
  await persistFavorites(nextItems, nextActive);
  showToast(`Removed ${favorite.name}`);
}

async function deleteActiveFavorite() {
  const favorite = currentFavorite();
  if (!favorite) {
    return;
  }
  if (!confirm(`Delete favorite "${favorite.name}"?`)) {
    return;
  }
  await removeFavorite(favorite.id);
}

async function moveActiveFavorite(delta) {
  const favorite = currentFavorite();
  if (!favorite) {
    return;
  }
  const currentItems = favorites().slice();
  const index = currentItems.findIndex((item) => item.id === favorite.id);
  const nextIndex = Math.max(0, Math.min(currentItems.length - 1, index + delta));
  if (index === nextIndex) {
    return;
  }
  currentItems.splice(index, 1);
  currentItems.splice(nextIndex, 0, favorite);
  await persistFavorites(currentItems, favorite.id);
}

async function openActiveFavorite(inOtherPane = false) {
  const favorite = currentFavorite();
  if (!favorite?.path) {
    return showToast("Select a favorite first");
  }
  const paneName = inOtherPane ? otherPane(app.activePane) : app.activePane;
  await loadPane(paneName, favorite.path);
  document.getElementById("favorites-dialog")?.close();
  focusPaneList(paneName);
}

async function openFavoritesDialog() {
  await loadState();
  renderFavoritesDialog();
  const dialog = document.getElementById("favorites-dialog");
  dialog.showModal();
  document.getElementById("favorite-name")?.focus();
}

function sortedAliases() {
  return pathAliases().slice().sort((left, right) => left.name.localeCompare(right.name));
}

function defaultAliasNameForPath(itemPath) {
  const name = labelForPath(itemPath)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return isValidAliasName(name) ? name : "path";
}

function activeAlias() {
  return pathAliases().find((alias) => alias.id === app.activeAliasId) || null;
}

function fillAliasForm(alias = null) {
  const currentPath = tabOf(app.activePane).path;
  document.getElementById("alias-id").value = alias?.id || "";
  document.getElementById("alias-name").value = alias?.name || defaultAliasNameForPath(currentPath);
  document.getElementById("alias-path").value = alias?.path || currentPath;
  document.getElementById("alias-description").value = alias?.description || "";
}

function renderAliasesDialog() {
  const aliases = sortedAliases();
  const list = document.getElementById("alias-list");
  if (!list) {
    return;
  }
  if (app.activeAliasId && !aliases.some((alias) => alias.id === app.activeAliasId)) {
    app.activeAliasId = null;
  }
  const active = activeAlias();
  document.getElementById("alias-summary").textContent = `${aliases.length} saved`;
  list.innerHTML = aliases.length
    ? aliases
        .map((alias) => {
          const selected = alias.id === app.activeAliasId ? " active" : "";
          return `<button class="${selected}" data-select-alias="${escapeHtml(alias.id)}" title="${escapeHtml(
            alias.path
          )}">
            <strong>${escapeHtml(alias.name)}:</strong>
            <small>${escapeHtml(alias.path)}</small>
            ${alias.description ? `<small>${escapeHtml(alias.description)}</small>` : ""}
          </button>`;
        })
        .join("")
    : `<div class="nav-empty">No aliases yet</div>`;
  fillAliasForm(active);
}

function openAliasesDialog() {
  renderAliasesDialog();
  document.getElementById("aliases-dialog").showModal();
  document.getElementById("alias-name").focus();
}

function newAlias() {
  app.activeAliasId = null;
  fillAliasForm();
}

function useActivePathForAlias() {
  const currentPath = tabOf(app.activePane).path;
  document.getElementById("alias-path").value = currentPath;
  if (!document.getElementById("alias-name").value.trim()) {
    document.getElementById("alias-name").value = defaultAliasNameForPath(currentPath);
  }
}

function aliasFromForm() {
  const id = document.getElementById("alias-id").value || crypto.randomUUID();
  const name = normalizeAliasName(document.getElementById("alias-name").value);
  const itemPath = document.getElementById("alias-path").value.trim();
  if (!isValidAliasName(name)) {
    throw new Error("Alias names need 2-32 letters, numbers, hyphens, or underscores.");
  }
  if (!itemPath) {
    throw new Error("Choose a path for this alias.");
  }
  return {
    id,
    name,
    path: itemPath,
    description: document.getElementById("alias-description").value.trim(),
    updatedAt: new Date().toISOString()
  };
}

async function saveAliasFromForm() {
  const alias = aliasFromForm();
  const aliases = pathAliases().filter(
    (item) => item.id !== alias.id && normalizeAliasName(item.name) !== alias.name
  );
  aliases.push(alias);
  app.state.aliases = aliases;
  app.activeAliasId = alias.id;
  await saveStateNow();
  renderRoots();
  renderAliasesDialog();
  showToast(`Alias saved: ${alias.name}:`);
}

async function deleteActiveAlias() {
  const alias = activeAlias();
  if (!alias) {
    return showToast("Select an alias first");
  }
  app.state.aliases = pathAliases().filter((item) => item.id !== alias.id);
  app.activeAliasId = null;
  await saveStateNow();
  renderRoots();
  renderAliasesDialog();
  showToast(`Deleted ${alias.name}:`);
}

async function openActiveAlias() {
  const alias = activeAlias() || aliasFromForm();
  await loadPane(app.activePane, alias.path);
  document.getElementById("aliases-dialog").close();
}

async function clearRecentLocations() {
  app.state.recentLocations = [];
  await saveStateNow();
  renderRoots();
  showToast("Recent locations cleared");
}

function compactText(value, maxLength = 180) {
  const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function operationDetailText(operation) {
  if (operation.type === "script") {
    const result = operation.result || {};
    const preview =
      operation.error ||
      result.logs?.[0] ||
      (result.result === undefined ? "" : compactText(result.result, 140));
    const context = result.contextPath ? labelForPath(result.contextPath) : "script";
    const selected = Number.isFinite(result.selectedCount) ? `${result.selectedCount} selected` : "";
    return [context, selected, preview].filter(Boolean).join(" / ");
  }
  if (operation.type === "edit-text") {
    const result = operation.result || {};
    return [
      result.path || operation.error,
      result.bytes !== undefined ? `${formatSize(result.previousBytes)} -> ${formatSize(result.bytes)}` : ""
    ]
      .filter(Boolean)
      .join(" / ");
  }
  return (
    operation.error ||
    operation.result?.trashDir ||
    operation.result?.path ||
    operation.result?.recycled?.[0] ||
    operation.result?.copied?.[0] ||
    operation.result?.moved?.[0] ||
    operation.result?.deleted?.[0] ||
    operation.result?.restored?.[0]?.dest ||
    operation.result?.renamed?.[0] ||
    operation.finishedAt ||
    operation.createdAt
  );
}

function activeOperations(operations = app.state?.operations || []) {
  return operations.filter(operationIsActive);
}

function operationIsActive(operation) {
  return ["queued", "running", "paused"].includes(operation.status);
}

function updateOperationReadout() {
  const readout = document.getElementById("operation-readout");
  if (!readout) {
    return;
  }
  const operations = app.state?.operations || [];
  const active = activeOperations(operations);
  const latest = operations[0];
  const summary = operationSummary();
  const compact = active.length
    ? active.length === 1
      ? String(active[0].status || "active")
      : `${active.length} active`
    : latest?.status === "failed"
      ? "Failed"
      : operations.length.toLocaleString();
  readout.classList.toggle("active", active.length > 0);
  readout.classList.toggle("failed", !active.length && latest?.status === "failed");
  const detail = active.length
    ? active
        .slice(0, 4)
        .map((operation) => `${operation.status}: ${operation.label || operation.type}`)
        .join("\n")
    : `${operations.length} recorded operation${operations.length === 1 ? "" : "s"}`;
  readout.title = detail;
  readout.setAttribute("aria-label", `Operations. ${summary}. ${detail.replace(/\n/g, ". ")}. Activate to open operations and recovery.`);
  readout.innerHTML = `<img class="dock-status-icon" src="/icons/history.svg" alt="" aria-hidden="true" />
    <span class="dock-status-value">${escapeHtml(compact)}</span>`;
}

function operationTiming(operation, now = Date.now()) {
  const start = Date.parse(operation.startedAt || operation.createdAt || "");
  if (!Number.isFinite(start)) {
    return "";
  }
  const end = operation.finishedAt ? Date.parse(operation.finishedAt) : now;
  if (!Number.isFinite(end)) {
    return "";
  }
  const duration = formatDuration(end - start);
  if (operation.status === "running") {
    return `${duration} elapsed`;
  }
  if (operation.status === "paused") {
    return `${duration} paused`;
  }
  if (operation.status === "queued") {
    return `queued ${duration}`;
  }
  return `${duration} total`;
}

function operationCountText(operation) {
  const result = operation.result || {};
  const countMap = [
    ["copied", "copied"],
    ["moved", "moved"],
    ["renamed", "renamed"],
    ["recycled", "recycled"],
    ["created", "created"],
    ["trashed", "trashed"],
    ["deleted", "deleted"],
    ["restored", "restored"],
    ["reverted", "reverted"],
    ["synced", "synced"],
    ["items", "item"]
  ];
  for (const [key, label] of countMap) {
    if (Array.isArray(result[key])) {
      return `${result[key].length} ${label}`;
    }
  }
  if (operation.type === "edit-text" && result.bytes !== undefined) {
    return "1 text file";
  }
  if (operation.type === "script" && Number.isFinite(result.selectedCount)) {
    return `${result.selectedCount} selected`;
  }
  return "";
}

function operationByteText(progress = {}) {
  const totalBytes = Number(progress.totalBytes || 0);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return "";
  }
  const completedBytes = Math.max(0, Number(progress.completedBytes || 0));
  return `${formatSize(completedBytes)} / ${formatSize(totalBytes)}`;
}

function operationRateText(progress = {}) {
  const bytesPerSecond = Number(progress.bytesPerSecond || 0);
  return Number.isFinite(bytesPerSecond) && bytesPerSecond > 0
    ? `${formatSize(bytesPerSecond)}/s`
    : "";
}

function operationEtaText(progress = {}) {
  const etaMs = Number(progress.etaMs);
  return Number.isFinite(etaMs) && etaMs > 0 ? `${formatDuration(etaMs)} left` : "";
}

function operationSupportsCancel(operation) {
  return ["copy", "move", "delete", "recycle", "transfer", "sync", "script"].includes(operation.type);
}

function operationSupportsPause(operation) {
  return operationSupportsCancel(operation);
}

function operationSupportsRetry(operation) {
  return ["failed", "canceled"].includes(operation.status) && Boolean(operation.retry?.type && operation.retry?.body);
}

function operationRecovery(operation) {
  const recovery = operation?.result?.recovery;
  return recovery && typeof recovery === "object" ? recovery : null;
}

function operationSupportsRetryRemaining(operation) {
  const recovery = operationRecovery(operation);
  return (
    ["failed", "canceled"].includes(operation.status) &&
    !recovery?.lastRetryOperationId &&
    Boolean(recovery?.retry?.type && recovery?.retry?.body)
  );
}

const elevatedRetryOperationTypes = new Set(["copy", "move", "delete"]);

function operationSupportsElevatedRetry(operation) {
  const recovery = operationRecovery(operation);
  return (
    operationSupportsRetryRemaining(operation) &&
    elevatedRetryOperationTypes.has(recovery?.retry?.type) &&
    Array.isArray(recovery?.remaining) &&
    recovery.remaining.length > 0
  );
}

function operationBackupRecoveryStatus(item) {
  const action = item?.backupRecovery?.action;
  if (action === "restored" || action === "discarded") {
    return action;
  }
  return item?.backup ? "available" : "none";
}

function operationBackupItems(operation) {
  const undo = operation?.undo;
  if (!undo || (undo.type !== "transfer" && undo.type !== "sync-copy")) {
    return [];
  }
  return (undo.items || [])
    .map((item, index) => {
      if (!item?.backup) {
        return null;
      }
      const status = operationBackupRecoveryStatus(item);
      const dest = item.dest || "";
      return {
        index,
        path: item.backup,
        backup: item.backup,
        dest,
        source: item.source || "",
        name: labelForPath(dest || item.backup),
        relativePath: item.relativePath || "",
        status,
        handled: status !== "available",
        kind:
          status === "restored"
            ? "Restored"
            : status === "discarded"
              ? "Kept"
              : undo.type === "sync-copy"
                ? "Sync backup"
                : item.mode === "move"
                  ? "Move backup"
                  : "Copy backup",
        handledAt: item.backupRecovery?.handledAt || null
      };
    })
    .filter(Boolean);
}

function operationBackupCanHandle(operation) {
  return operation?.status === "completed" && operation?.undo && !operation.undo.appliedAt;
}

function operationRecoveryReport(operation) {
  const recovery = operationRecovery(operation);
  const backups = operationBackupItems(operation);
  if (!recovery && !backups.length) {
    return "";
  }
  const lines = [
    `Operation: ${operation.label || operation.type}`,
    `Status: ${operation.status}`,
    operation.error ? `Error: ${operation.error}` : "",
    `Completed: ${recovery?.completedCount || 0}`,
    `Remaining: ${recovery?.remainingCount || 0}`,
    recovery?.targetDir ? `Target: ${recovery.targetDir}` : "",
    recovery?.failed ? `Failed: ${recovery.failed.path} (${recovery.failed.reason || "failed"})` : "",
    "",
    "Completed items:",
    ...(recovery?.completed || []).map((item) => `- ${item.path}${item.dest ? ` -> ${item.dest}` : ""}`),
    "",
    "Remaining items:",
    ...(recovery?.remaining || []).map((item) => `- ${item.path}`),
    "",
    "Overwrite backups:",
    ...backups.map((item) => `- [${item.status}] ${item.backup} -> ${item.dest || "unknown destination"}`)
  ].filter((line, index, source) => line || source[index - 1] !== "");
  return lines.join("\n");
}

function operationRecoveryMarkup(operation) {
  const recovery = operationRecovery(operation);
  if (!recovery) {
    return "";
  }
  const failed = recovery.failed;
  const completedPreview = (recovery.completed || []).slice(0, 3);
  const remainingPreview = (recovery.remaining || []).slice(0, 3);
  const completedMore = Math.max(0, Number(recovery.completedCount || 0) - completedPreview.length);
  const remainingMore = Math.max(0, Number(recovery.remainingCount || 0) - remainingPreview.length);
  return `<div class="operation-recovery">
    <div class="operation-recovery-head">
      <strong>Recovery</strong>
      <span>${escapeHtml(recovery.completedCount || 0)} done</span>
      <span>${escapeHtml(recovery.remainingCount || 0)} remaining</span>
    </div>
    ${
      failed
        ? `<div class="operation-recovery-failed">
            <span>Failed</span>
            <code title="${escapeHtml(failed.path)}">${escapeHtml(failed.name || failed.path)}</code>
            <small>${escapeHtml(failed.reason || "failed")}</small>
          </div>`
        : ""
    }
    <div class="operation-recovery-lists">
      <div>
        <span>Completed</span>
        ${
          completedPreview.length
            ? completedPreview
                .map((item) => `<code title="${escapeHtml(item.dest || item.path)}">${escapeHtml(item.name || item.path)}</code>`)
                .join("")
            : `<small>None yet</small>`
        }
        ${completedMore ? `<small>+ ${completedMore} more</small>` : ""}
      </div>
      <div>
        <span>Remaining</span>
        ${
          remainingPreview.length
            ? remainingPreview
                .map((item) => `<code title="${escapeHtml(item.path)}">${escapeHtml(item.name || item.path)}</code>`)
                .join("")
            : `<small>None</small>`
        }
        ${remainingMore ? `<small>+ ${remainingMore} more</small>` : ""}
      </div>
    </div>
  </div>`;
}

function operationById(operationId) {
  return (app.state?.operations || []).find((operation) => operation.id === operationId) || null;
}

function recoveryItemIndex(item, offset) {
  const index = Number(item?.index);
  return Number.isInteger(index) && index >= 0 ? index : offset;
}

function recoveryItemSubtitle(item, fallback = "") {
  if (item?.relativePath) {
    return item.relativePath;
  }
  if (item?.dest) {
    return item.dest;
  }
  if (fallback) {
    return fallback;
  }
  return item?.path || "";
}

function operationDetailRowMarkup(item, offset, options = {}) {
  const index = recoveryItemIndex(item, offset);
  const selectable = options.selectable === true;
  const rowSelectable = selectable && (!options.canSelectItem || options.canSelectItem(item, index));
  const selectionSet = options.selectionSet || app.operationDetails.selectedRemaining;
  const selected = rowSelectable && selectionSet.has(index);
  const classes = [
    "operation-detail-row",
    selectable ? "selectable" : "",
    selected ? "selected" : "",
    options.failed ? "failed" : "",
    item?.handled ? "handled" : ""
  ]
    .filter(Boolean)
    .join(" ");
  const selectDataAttribute = options.selectDataAttribute || "operation-recovery-select";
  const checkbox = selectable
    ? `<input type="checkbox" data-${selectDataAttribute}="${index}" ${selected ? "checked" : ""} ${
        rowSelectable ? "" : "disabled"
      } />`
    : "";
  const kind = item?.kind || options.kind || item?.reason || "Item";
  const subtitle = recoveryItemSubtitle(item, options.fallbackSubtitle || "");
  return `<label class="${classes}">
    ${checkbox}
    <div>
      <strong title="${escapeHtml(item?.path || "")}">${escapeHtml(item?.name || item?.path || "Item")}</strong>
      <code title="${escapeHtml(item?.path || "")}">${escapeHtml(item?.path || "")}</code>
    </div>
    <div>
      <small>${escapeHtml(options.destinationLabel || "Destination")}</small>
      <code title="${escapeHtml(subtitle)}">${escapeHtml(subtitle || "None")}</code>
    </div>
    <span class="operation-detail-kind" title="${escapeHtml(kind)}">${escapeHtml(kind)}</span>
  </label>`;
}

function operationDetailListMarkup(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return `<div class="empty-state">${escapeHtml(options.empty || "No items")}</div>`;
  }
  return `<div class="operation-detail-list">${list
    .map((item, index) => operationDetailRowMarkup(item, index, options))
    .join("")}</div>`;
}

function renderOperationDetails() {
  const operation = operationById(app.operationDetails?.id);
  const title = document.getElementById("operation-details-title");
  const meta = document.getElementById("operation-details-meta");
  const body = document.getElementById("operation-details-body");
  if (!title || !meta || !body) {
    return;
  }
  if (!operation) {
    title.textContent = "Operation Details";
    meta.textContent = "";
    body.innerHTML = `<div class="empty-state">Operation is no longer available.</div>`;
    return;
  }
  const recovery = operationRecovery(operation);
  const remaining = Array.isArray(recovery?.remaining) ? recovery.remaining : [];
  const completed = Array.isArray(recovery?.completed) ? recovery.completed : [];
  const backups = operationBackupItems(operation);
  const failed = recovery?.failed ? [recovery.failed] : [];
  const elevation = recovery?.elevation && typeof recovery.elevation === "object" ? recovery.elevation : null;
  const selectedCount = remaining.filter((item, offset) =>
    app.operationDetails.selectedRemaining.has(recoveryItemIndex(item, offset))
  ).length;
  const availableBackups = backups.filter((item) => item.status === "available");
  const selectedBackupCount = availableBackups.filter((item) => app.operationDetails.selectedBackups.has(item.index)).length;
  const canRetryRemaining = operationSupportsRetryRemaining(operation);
  const canRetrySelected = canRetryRemaining && selectedCount > 0;
  const canElevateRemaining = operationSupportsElevatedRetry(operation);
  const canElevateSelected = canElevateRemaining && selectedCount > 0;
  const canHandleBackups = operationBackupCanHandle(operation);
  const canHandleSelectedBackups = canHandleBackups && selectedBackupCount > 0;
  const selectedRetries = Array.isArray(recovery?.selectedRetries) ? recovery.selectedRetries : [];
  title.textContent = operation.label || operation.type || "Operation Details";
  meta.textContent = operationMeta(operation, false).join(" / ");
  const backupSection = backups.length
    ? `<section class="operation-details-section">
        <div class="operation-details-section-head">
          <strong>Overwrite Backups</strong>
          <span>${selectedBackupCount} selected / ${availableBackups.length} available</span>
          <div class="operation-details-actions">
            <button data-operation-details-action="backup-select-all" ${availableBackups.length ? "" : "disabled"}>Select All</button>
            <button data-operation-details-action="backup-select-none" ${backups.length ? "" : "disabled"}>Clear</button>
            <button data-operation-details-action="backup-restore" ${canHandleSelectedBackups ? "" : "disabled"}>Restore Original</button>
            <button data-operation-details-action="backup-discard" ${canHandleSelectedBackups ? "" : "disabled"}>Keep Replacement</button>
          </div>
        </div>
        ${operationDetailListMarkup(backups, {
          empty: "No overwrite backups recorded",
          selectable: canHandleBackups,
          selectionSet: app.operationDetails.selectedBackups,
          selectDataAttribute: "operation-backup-select",
          canSelectItem: (item) => item.status === "available",
          destinationLabel: "Destination",
          fallbackSubtitle: ""
        })}
      </section>`
    : "";
  body.innerHTML = `<section class="operation-details-summary">
    <div><span>Status</span><strong>${escapeHtml(operation.status || "")}</strong></div>
    <div><span>Completed</span><strong>${escapeHtml(recovery?.completedCount || completed.length || 0)}</strong></div>
    <div><span>Remaining</span><strong>${escapeHtml(recovery?.remainingCount || remaining.length || 0)}</strong></div>
    <div><span>Backups</span><strong>${escapeHtml(`${availableBackups.length} available / ${backups.length}`)}</strong></div>
    <div><span>Last Retry</span><strong>${escapeHtml(
      recovery?.lastRetryOperationId
        ? "All remaining"
        : recovery?.lastSelectedRetryOperationId
          ? `${selectedRetries[0]?.count || selectedCount || 0} selected`
          : "None"
    )}</strong></div>
    <div><span>Elevated</span><strong>${escapeHtml(
      elevation?.status
        ? `${elevation.status}${elevation.itemCount ? ` / ${elevation.itemCount}` : ""}`
        : canElevateRemaining
          ? "Ready"
          : "Unavailable"
    )}</strong></div>
  </section>
  ${
    elevation
      ? `<section class="operation-details-section operation-elevation-section">
          <div class="operation-details-section-head">
            <strong>Elevated Helper</strong>
            <span>${escapeHtml(elevation.status || "prepared")}</span>
          </div>
          <div class="operation-elevation-summary">
            <div><span>Items</span><strong>${escapeHtml(elevation.itemCount || 0)}</strong></div>
            <div><span>Type</span><strong>${escapeHtml(elevation.type || "")}</strong></div>
            <div><span>Prepared</span><strong>${escapeHtml(
              elevation.plannedAt ? formatDate(Date.parse(elevation.plannedAt)) : "Now"
            )}</strong></div>
            <div><span>Log</span><code title="${escapeHtml(elevation.logPath || "")}">${escapeHtml(
              elevation.logPath || "Not written yet"
            )}</code></div>
          </div>
          ${
            elevation.command
              ? `<code class="operation-elevation-command" title="${escapeHtml(elevation.command)}">${escapeHtml(
                  elevation.command
                )}</code>`
              : ""
          }
        </section>`
      : ""
  }
  ${
    recovery
      ? `<section class="operation-details-section">
          <div class="operation-details-section-head">
            <strong>Failed Item</strong>
            <span>${escapeHtml(recovery.type || operation.type || "")}</span>
          </div>
          ${operationDetailListMarkup(failed, {
            empty: "No failed item recorded",
            failed: true,
            kind: recovery.failed?.reason || "Failed",
            destinationLabel: recovery.type === "sync" ? "Relative path" : "Target",
            fallbackSubtitle: recovery.targetDir || ""
          })}
        </section>
        <section class="operation-details-section">
          <div class="operation-details-section-head">
            <strong>Remaining Work</strong>
            <span>${selectedCount} selected / ${remaining.length} item(s)</span>
            <div class="operation-details-actions">
              <button data-operation-details-action="select-all" ${remaining.length ? "" : "disabled"}>Select All</button>
              <button data-operation-details-action="select-none" ${remaining.length ? "" : "disabled"}>Clear</button>
              <button data-operation-details-action="retry-selected" ${canRetrySelected ? "" : "disabled"}>Retry Selected</button>
              <button data-operation-details-action="retry-remaining" ${canRetryRemaining ? "" : "disabled"}>Retry All Remaining</button>
              <button class="operation-elevate" data-operation-details-action="elevate-selected" ${canElevateSelected ? "" : "disabled"}>Elevate Selected</button>
              <button class="operation-elevate" data-operation-details-action="elevate-remaining" ${canElevateRemaining ? "" : "disabled"}>Elevate All</button>
            </div>
          </div>
          ${operationDetailListMarkup(remaining, {
            empty: recovery?.lastRetryOperationId ? "Remaining work has already been retried." : "No remaining items",
            selectable: canRetryRemaining,
            kind: "Remaining",
            destinationLabel: recovery.type === "sync" ? "Relative path" : "Target",
            fallbackSubtitle: recovery.targetDir || ""
          })}
        </section>
        <section class="operation-details-section">
          <div class="operation-details-section-head">
            <strong>Completed Items</strong>
            <span>${completed.length} shown</span>
          </div>
          ${operationDetailListMarkup(completed, {
            empty: "No completed items recorded",
            kind: "Completed",
            destinationLabel: "Destination"
          })}
        </section>`
      : ""
  }
  ${backupSection}
  ${!recovery && !backups.length ? `<div class="empty-state">No recovery details for this operation.</div>` : ""}`;
}

function openOperationDetails(operationId) {
  const operation = operationById(operationId);
  const recovery = operationRecovery(operation);
  const remaining = Array.isArray(recovery?.remaining) ? recovery.remaining : [];
  const backups = operationBackupItems(operation).filter((item) => item.status === "available");
  app.operationDetails = {
    id: operationId,
    selectedRemaining: new Set(remaining.map((item, index) => recoveryItemIndex(item, index))),
    selectedBackups: new Set(backups.map((item) => item.index))
  };
  renderOperationDetails();
  document.getElementById("operation-details-dialog").showModal();
}

function setOperationDetailsSelection(mode) {
  const operation = operationById(app.operationDetails?.id);
  const recovery = operationRecovery(operation);
  const remaining = Array.isArray(recovery?.remaining) ? recovery.remaining : [];
  app.operationDetails.selectedRemaining =
    mode === "all"
      ? new Set(remaining.map((item, index) => recoveryItemIndex(item, index)))
      : new Set();
  renderOperationDetails();
}

function setOperationDetailsBackupSelection(mode) {
  const operation = operationById(app.operationDetails?.id);
  const backups = operationBackupItems(operation).filter((item) => item.status === "available");
  app.operationDetails.selectedBackups = mode === "all" ? new Set(backups.map((item) => item.index)) : new Set();
  renderOperationDetails();
}

function selectedOperationRecoveryIndexes() {
  return [...(app.operationDetails.selectedRemaining || new Set())];
}

function selectedOperationBackupIndexes() {
  return [...(app.operationDetails.selectedBackups || new Set())];
}

function operationMeta(operation, canUndo) {
  const progress = operation.progress || {};
  const progressCount =
    Number.isFinite(progress.completed) && Number.isFinite(progress.total) && progress.total > 0
      ? `${progress.completed}/${progress.total} ${progress.unit || "items"}`
      : "";
  const byteText = operationByteText(progress);
  const rateText = operationRateText(progress);
  return [
    operation.type,
    operationTiming(operation),
    progressCount,
    byteText,
    rateText,
    operationCountText(operation),
    operation.finishedAt ? formatDate(Date.parse(operation.finishedAt)) : "",
    operation.cancelRequestedAt && operation.status !== "canceled" ? "cancel requested" : "",
    operation.retryOf ? "retry" : "",
    operationRecovery(operation) ? "recovery details" : "",
    operationRecovery(operation)?.elevation ? "elevated helper" : "",
    operationBackupItems(operation).length ? "overwrite backups" : "",
    operation.retry?.lastRetryOperationId ? "retried" : operationSupportsRetry(operation) ? "retryable" : "",
    operationRecovery(operation)?.lastRetryOperationId ? "remainder retried" : "",
    operation.undo?.appliedAt ? "undone" : canUndo ? "undoable" : ""
  ].filter(Boolean);
}

function operationProgressMarkup(operation) {
  const progress = operation.progress;
  if (!progress) {
    return "";
  }
  const total = Number(progress.total || 0);
  const completed = Number(progress.completed || 0);
  const totalBytes = Number(progress.totalBytes || 0);
  const completedBytes = Number(progress.completedBytes || 0);
  const percent = totalBytes > 0
    ? Math.max(0, Math.min(100, Math.round((completedBytes / totalBytes) * 100)))
    : total > 0
      ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
      : 0;
  const current = progress.current ? ` / ${progress.current}` : "";
  const currentBytes =
    Number(progress.currentTotalBytes || 0) > 0
      ? `${formatSize(progress.currentBytes || 0)} / ${formatSize(progress.currentTotalBytes)} current`
      : "";
  const showEta = operation.status === "queued" || operation.status === "running";
  const label = [
    progress.phase || "Working",
    total > 0 ? `${completed}/${total} ${progress.unit || "items"}` : "",
    operationByteText(progress),
    operationRateText(progress),
    showEta ? operationEtaText(progress) : "",
    currentBytes,
    current
  ]
    .filter(Boolean)
    .join(" ");
  return `<div class="operation-progress" title="${escapeHtml(progress.currentPath || label)}">
    <div class="operation-progress-bar" style="width:${percent}%"></div>
    <span>${escapeHtml(label)}</span>
  </div>`;
}

function renderOperations() {
  const list = document.getElementById("operation-list");
  if (!list) {
    return;
  }
  const operations = app.state?.operations || [];
  updateOperationReadout();
  if (!operations.length) {
    list.innerHTML = `<div class="empty-state">No operations</div>`;
    return;
  }
  list.innerHTML = operations
    .map((operation) => {
      const canUndo =
        operation.status === "completed" &&
        operation.undo &&
        !operation.undo.appliedAt &&
        operation.type !== "undo";
      const canCancel =
        (operation.status === "queued" || operation.status === "running" || operation.status === "paused") &&
        operationSupportsCancel(operation) &&
        !operation.cancelRequestedAt;
      const canPause =
        operation.status === "running" &&
        operationSupportsPause(operation) &&
        !operation.cancelRequestedAt;
      const canResume =
        operation.status === "paused" &&
        operationSupportsPause(operation) &&
        !operation.cancelRequestedAt;
      const canRetry = operationSupportsRetry(operation);
      const canRetryRemaining = operationSupportsRetryRemaining(operation);
      const canElevateRemaining = operationSupportsElevatedRetry(operation);
      const hasRecovery = Boolean(operationRecovery(operation));
      const hasDetails = hasRecovery || operationBackupItems(operation).length > 0;
      const detail = operationDetailText(operation);
      const isActive = operationIsActive(operation);
      const meta = operationMeta(operation, canUndo);
      const progressMarkup = operationProgressMarkup(operation);
      const recoveryMarkup = operationRecoveryMarkup(operation);
      return `<div class="operation-row ${escapeHtml(operation.status)}${isActive ? " active" : ""}">
        <div>
          <strong>${escapeHtml(operation.label || operation.type)}</strong>
          <small>${escapeHtml(detail || "")}</small>
          <div class="operation-meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
          ${progressMarkup || (isActive ? `<div class="operation-pulse" aria-hidden="true"></div>` : "")}
          ${recoveryMarkup}
        </div>
        <div class="operation-actions">
          <span class="operation-status ${escapeHtml(operation.status)}">${escapeHtml(
            operation.status
          )}</span>
          ${
            canRetryRemaining
              ? `<button class="operation-retry" data-retry-remaining-operation="${escapeHtml(operation.id)}">Retry Remaining</button>`
              : ""
          }
          ${
            canElevateRemaining
              ? `<button class="operation-elevate" data-elevated-retry-operation="${escapeHtml(operation.id)}">Elevate Remaining</button>`
              : ""
          }
          ${
            canRetry
              ? `<button class="operation-retry" data-retry-operation="${escapeHtml(operation.id)}">Retry</button>`
              : ""
          }
          ${
            hasDetails
              ? `<button data-operation-details="${escapeHtml(operation.id)}">Details</button>`
              : ""
          }
          ${
            hasDetails
              ? `<button data-copy-operation-report="${escapeHtml(operation.id)}">Copy Report</button>`
              : ""
          }
          ${
            canUndo
              ? `<button data-undo-operation="${escapeHtml(operation.id)}">Undo</button>`
              : ""
          }
          ${
            canPause
              ? `<button class="operation-pause" data-pause-operation="${escapeHtml(operation.id)}">Pause</button>`
              : ""
          }
          ${
            canResume
              ? `<button class="operation-resume" data-resume-operation="${escapeHtml(operation.id)}">Resume</button>`
              : ""
          }
          ${
            canCancel
              ? `<button class="operation-cancel" data-cancel-operation="${escapeHtml(operation.id)}">Cancel</button>`
              : ""
          }
        </div>
      </div>`;
    })
    .join("");
}

async function openOpsDialog() {
  await syncStateAndChrome();
  document.getElementById("ops-dialog").showModal();
}

async function cancelOperation(operationId) {
  const result = await request("/api/operation/cancel", {
    method: "POST",
    body: JSON.stringify({ operationId })
  });
  if (result.operation) {
    const operations = app.state.operations || [];
    const index = operations.findIndex((operation) => operation.id === result.operation.id);
    if (index === -1) {
      operations.unshift(result.operation);
    } else {
      operations[index] = result.operation;
    }
    app.state.operations = operations;
  }
  renderOperations();
  scheduleOperationPoll(200);
  showToast("Cancel requested");
}

async function pauseOperation(operationId) {
  const result = await request("/api/operation/pause", {
    method: "POST",
    body: JSON.stringify({ operationId })
  });
  if (result.operation) {
    const operations = app.state.operations || [];
    const index = operations.findIndex((operation) => operation.id === result.operation.id);
    if (index === -1) {
      operations.unshift(result.operation);
    } else {
      operations[index] = result.operation;
    }
    app.state.operations = operations;
  }
  renderOperations();
  scheduleOperationPoll(200);
  showToast("Operation paused");
}

async function resumeOperation(operationId) {
  const result = await request("/api/operation/resume", {
    method: "POST",
    body: JSON.stringify({ operationId })
  });
  if (result.operation) {
    const operations = app.state.operations || [];
    const index = operations.findIndex((operation) => operation.id === result.operation.id);
    if (index === -1) {
      operations.unshift(result.operation);
    } else {
      operations[index] = result.operation;
    }
    app.state.operations = operations;
  }
  renderOperations();
  scheduleOperationPoll(200);
  showToast("Operation resumed");
}

async function undoOperation(operationId) {
  await request("/api/operation/undo", {
    method: "POST",
    body: JSON.stringify({ operationId })
  });
  await Promise.all([refreshPane("left"), refreshPane("right")]);
  await syncStateAndChrome();
  showToast("Undo complete");
}

async function retryOperation(operationId) {
  const result = await request("/api/operation/retry", {
    method: "POST",
    body: JSON.stringify({ operationId })
  });
  if (result.operation) {
    const operations = app.state.operations || [];
    const index = operations.findIndex((operation) => operation.id === result.operation.id);
    if (index === -1) {
      operations.unshift(result.operation);
    } else {
      operations[index] = result.operation;
    }
    app.state.operations = operations;
  }
  await Promise.all([refreshPane("left"), refreshPane("right")]);
  await syncStateAndChrome();
  showToast("Retry complete");
}

async function retryRemainingOperation(operationId) {
  const result = await request("/api/operation/retry-remaining", {
    method: "POST",
    body: JSON.stringify({ operationId })
  });
  if (result.operation) {
    const operations = app.state.operations || [];
    const index = operations.findIndex((operation) => operation.id === result.operation.id);
    if (index === -1) {
      operations.unshift(result.operation);
    } else {
      operations[index] = result.operation;
    }
    app.state.operations = operations;
  }
  await Promise.all([refreshPane("left"), refreshPane("right")]);
  await syncStateAndChrome();
  showToast("Remaining work retried");
}

async function retrySelectedRemainingOperation(operationId, indexes) {
  const result = await request("/api/operation/retry-selected", {
    method: "POST",
    body: JSON.stringify({ operationId, indexes })
  });
  if (result.operation) {
    const operations = app.state.operations || [];
    const index = operations.findIndex((operation) => operation.id === result.operation.id);
    if (index === -1) {
      operations.unshift(result.operation);
    } else {
      operations[index] = result.operation;
    }
    app.state.operations = operations;
  }
  await Promise.all([refreshPane("left"), refreshPane("right")]);
  await syncStateAndChrome();
  renderOperationDetails();
  showToast(`${indexes.length} selected item(s) retried`);
}

function upsertOperationInState(operation) {
  if (!operation) {
    return;
  }
  const operations = app.state.operations || [];
  const index = operations.findIndex((item) => item.id === operation.id);
  if (index === -1) {
    operations.unshift(operation);
  } else {
    operations[index] = operation;
  }
  app.state.operations = operations;
}

async function elevatedRetryOperation(operationId, indexes = []) {
  const selectedIndexes = Array.isArray(indexes) ? indexes : [];
  const result = await request("/api/operation/elevated-retry", {
    method: "POST",
    body: JSON.stringify({ operationId, indexes: selectedIndexes, launch: true })
  });
  if (result.operation) {
    upsertOperationInState(result.operation);
  }
  renderOperations();
  renderOperationDetails();
  if (result.launched) {
    showToast(`Elevated helper launched for ${result.itemCount || selectedIndexes.length || 0} item(s)`);
    setTimeout(() => {
      Promise.all([refreshPane("left"), refreshPane("right")]).catch((error) => setStatus(error.message));
    }, 2500);
  } else if (result.prepared) {
    showToast("Elevated helper prepared");
  } else {
    showToast("Elevated retry plan ready");
  }
}

async function recoverSelectedOperationBackups(operationId, action, indexes) {
  if (!indexes.length) {
    return showToast("Select backup items first");
  }
  if (action === "discard") {
    const ok = confirm("Keep the replacement and permanently discard the selected original backup(s)?");
    if (!ok) return;
  }
  const result = await request("/api/operation/backup-recovery", {
    method: "POST",
    body: JSON.stringify({ operationId, action, indexes })
  });
  if (result.operation) {
    const operations = app.state.operations || [];
    const index = operations.findIndex((operation) => operation.id === result.operation.id);
    if (index === -1) {
      operations.unshift(result.operation);
    } else {
      operations[index] = result.operation;
    }
    app.state.operations = operations;
  }
  await Promise.all([refreshPane("left"), refreshPane("right")]);
  await syncStateAndChrome();
  const operation = operationById(operationId);
  app.operationDetails.selectedBackups = new Set(
    operationBackupItems(operation)
      .filter((item) => item.status === "available")
      .map((item) => item.index)
  );
  renderOperationDetails();
  showToast(action === "discard" ? "Replacement kept" : "Original restored");
}

async function copyOperationRecoveryReport(operationId) {
  const operation = (app.state?.operations || []).find((item) => item.id === operationId);
  const report = operationRecoveryReport(operation);
  if (!report) {
    return showToast("No recovery report for that operation");
  }
  await request("/api/clipboard/text", {
    method: "POST",
    body: JSON.stringify({ text: report })
  });
  showToast("Recovery report copied");
}

async function clearOperations() {
  app.state = await request("/api/operations/clear", { method: "POST" });
  renderOperations();
  showToast("History cleared");
}

function renderIntegration() {
  const integration = app.state?.integration || {};
  const status = app.integrationStatus || {};
  const registry = status.registry || {};
  const shellBackup = registry.shellBackup || {};
  const shortcuts = status.shortcuts || {};
  const files = status.files || {};
  const native = status.native || {};
  const handler = status.handler || {};
  const replacement = status.replacement || {};
  const settings = app.state?.settings || {};
  const generated = integration.generatedAt ? formatDate(Date.parse(integration.generatedAt)) : "No";
  const launchMode = document.getElementById("launch-mode");
  if (launchMode) {
    launchMode.value = normalizeLaunchMode(settings.launchMode);
  }
  const shellOpenMode = document.getElementById("shell-open-mode");
  if (shellOpenMode) {
    shellOpenMode.value = normalizeShellOpenMode(settings.shellOpenMode);
  }
  document.getElementById("integration-generated").textContent = generated;
  document.getElementById("integration-level").textContent =
    replacement.level || "Not configured";
  document.getElementById("integration-readiness").textContent = `${replacement.ready || 0} / ${
    replacement.total || 5
  }`;
  document.getElementById("integration-browser").textContent =
    status.browser || "No Edge/Chrome app-mode browser found";
  document.getElementById("integration-native").textContent = native.available
    ? native.launcher || "Electron launcher available"
    : "Run npm install to enable Electron native window";
  document.getElementById("integration-packaged").textContent =
    native.packaged || native.packagedCandidate || "Package not built";
  document.getElementById("integration-installed").textContent =
    native.installed || native.installedCandidate || "Not installed";
  const handlerLabel =
    handler.kind === "installed" ? "Installed" : handler.kind === "packaged" ? "Packaged" : "Launcher";
  document.getElementById("integration-handler").textContent = handler.target
    ? `${handlerLabel}: ${handler.target}`
    : "Not generated";
  document.getElementById("integration-launcher").textContent = integration.scriptPath || "";
  document.getElementById("integration-server").textContent = integration.serverScriptPath || "";
  const shortcutText = shortcuts.startMenu
    ? shortcuts.desktop
      ? "Start Menu and Desktop installed"
      : "Start Menu installed"
    : "Not installed";
  document.getElementById("integration-shortcuts").textContent = shortcutText;
  document.getElementById("integration-context").textContent = registry.contextMenuInstalled
    ? `Installed: ${integration.contextMenuRegPath || ""}`
    : `Not installed: ${integration.contextMenuRegPath || ""}`;
  document.getElementById("integration-default").textContent = registry.folderDefaultEnabled
    ? `Default handler: ${integration.folderDefaultRegPath || ""}`
    : `Not default: ${integration.folderDefaultRegPath || ""}`;
  document.getElementById("integration-backup").textContent = shellBackup.available
    ? `${shellBackup.mode || "manual"} backup: ${formatDate(Date.parse(shellBackup.createdAt))}${
        shellBackup.restoredAt ? ` / restored ${formatDate(Date.parse(shellBackup.restoredAt))}` : ""
      }`
    : `No backup: ${shellBackup.restoreRegPath || ""}`;
  document.getElementById("integration-wine").textContent = shortcuts.winEStartup
    ? "Startup helper installed"
    : files.winEHotkey
      ? "Generated, not installed"
      : "Not generated";
  document.getElementById("integration-wine-file").textContent = shortcuts.winEStartup
    ? shortcuts.winEStartupShortcut || ""
    : integration.winEHotkeyPath || "";

  const steps = Array.isArray(replacement.steps) ? replacement.steps : [];
  document.getElementById("integration-steps").innerHTML = steps
    .map(
      (step) => `<div class="integration-step ${step.ready ? "ready" : "pending"}">
        <span>${step.ready ? "OK" : "TODO"}</span>
        <strong>${escapeHtml(step.label)}</strong>
        <code>${escapeHtml(step.detail || "")}</code>
      </div>`
    )
    .join("");
  renderIntegrationPreflight(status.preflight);

  setStatusCode("integration-browser", Boolean(status.browser));
  setStatusCode("integration-native", Boolean(native.available));
  setStatusCode("integration-packaged", Boolean(native.packaged));
  setStatusCode("integration-installed", Boolean(native.installed));
  setStatusCode("integration-handler", handler.kind === "installed" || handler.kind === "packaged");
  setStatusCode("integration-launcher", Boolean(files.launcher));
  setStatusCode("integration-server", Boolean(files.server));
  setStatusCode("integration-shortcuts", Boolean(shortcuts.startMenu));
  setStatusCode("integration-context", Boolean(registry.contextMenuInstalled));
  setStatusCode("integration-default", Boolean(registry.folderDefaultEnabled));
  setStatusCode("integration-backup", Boolean(shellBackup.available));
  setStatusCode("integration-wine", Boolean(shortcuts.winEStartup));
  setStatusCode("integration-wine-file", Boolean(files.winEHotkey));
}

function preflightStateLabel(state) {
  if (state === "block") {
    return "Blocked";
  }
  if (state === "warn") {
    return "Review";
  }
  return "Ready";
}

function renderIntegrationPreflight(preflight = {}) {
  const container = document.getElementById("integration-preflight");
  if (!container) {
    return;
  }
  const items = Array.isArray(preflight.items) ? preflight.items : [];
  if (!items.length) {
    container.innerHTML = "";
    return;
  }
  const targetText = preflight.installTarget ? `Target: ${preflight.installTarget}` : "";
  container.innerHTML = `<div class="integration-preflight-head ${escapeHtml(preflight.state || "ready")}">
    <div>
      <span class="field-label">Shell Preflight</span>
      <strong>${escapeHtml(preflight.summary || preflightStateLabel(preflight.state))}</strong>
      <code title="${escapeHtml(targetText)}">${escapeHtml(targetText)}</code>
    </div>
    <span class="preflight-badge ${escapeHtml(preflight.state || "ready")}">${escapeHtml(
      preflightStateLabel(preflight.state)
    )}</span>
  </div>
  <div class="integration-preflight-list">
    ${items
      .map(
        (item) => `<div class="preflight-item ${escapeHtml(item.state || "ready")}">
          <span>${escapeHtml(preflightStateLabel(item.state))}</span>
          <strong>${escapeHtml(item.label)}</strong>
          <code title="${escapeHtml(item.detail || "")}">${escapeHtml(item.detail || "")}</code>
          <small>${escapeHtml(item.action || "")}</small>
        </div>`
      )
      .join("")}
  </div>`;
}

function setStatusCode(id, ok) {
  const element = document.getElementById(id);
  if (!element) return;
  element.classList.toggle("good", ok);
  element.classList.toggle("warn", !ok);
}

async function openIntegrationDialog() {
  await syncStateAndChrome();
  document.getElementById("integration-dialog").showModal();
}

async function generateIntegrationFiles() {
  const result = await request("/api/integration/generate", { method: "POST" });
  document.getElementById("integration-output").textContent = JSON.stringify(result, null, 2);
  await syncStateAndChrome();
}

async function applyIntegration(mode) {
  if (mode === "shortcuts" || mode === "shortcutsRemove") {
    if (mode === "shortcutsRemove") {
      const ok = confirm("Remove the current-user Start Menu and Desktop Explore Better shortcuts?");
      if (!ok) return;
    }
    const result = await request("/api/integration/shortcuts", {
      method: "POST",
      body: JSON.stringify({ mode: mode === "shortcutsRemove" ? "remove" : "install", desktop: true })
    });
    document.getElementById("integration-output").textContent = JSON.stringify(result, null, 2);
    await syncStateAndChrome();
    return;
  }

  if (mode === "testOpen") {
    const result = await request("/api/integration/test-open", {
      method: "POST",
      body: JSON.stringify({ path: tabOf(app.activePane).path })
    });
    document.getElementById("integration-output").textContent = JSON.stringify(result, null, 2);
    await syncStateAndChrome();
    return;
  }

  if (mode === "backupShell" || mode === "restoreShell") {
    if (mode === "restoreShell") {
      const ok = confirm("Restore the previous current-user folder and drive shell settings from the last backup?");
      if (!ok) return;
    }
    const result = await request(
      mode === "backupShell" ? "/api/integration/backup" : "/api/integration/restore",
      {
        method: "POST",
        body: JSON.stringify({ mode: mode === "backupShell" ? "manual" : "restore" })
      }
    );
    document.getElementById("integration-output").textContent = JSON.stringify(result, null, 2);
    await syncStateAndChrome();
    return;
  }

  if (mode === "appInstall" || mode === "appRemove") {
    if (mode === "appRemove") {
      const ok = confirm("Remove the current-user installed Explore Better app copy?");
      if (!ok) return;
    }
    const result = await request("/api/integration/app-package", {
      method: "POST",
      body: JSON.stringify({ mode: mode === "appRemove" ? "remove" : "install" })
    });
    document.getElementById("integration-output").textContent = JSON.stringify(result, null, 2);
    await syncStateAndChrome();
    return;
  }

  if (mode === "cleanupIntegration") {
    const ok = confirm(
      "Remove current-user Explore Better shortcuts, Win+E helper, context menu, and default folder handler? The installed app copy stays installed."
    );
    if (!ok) return;
    const result = await request("/api/integration/cleanup", {
      method: "POST",
      body: JSON.stringify({ restoreBackup: true })
    });
    document.getElementById("integration-output").textContent = JSON.stringify(result, null, 2);
    await syncStateAndChrome();
    return;
  }

  if (mode === "winEInstall" || mode === "winERemove") {
    if (mode === "winEInstall") {
      const ok = confirm("Install the current-user Win+E startup helper?");
      if (!ok) return;
    }
    const result = await request("/api/integration/win-e", {
      method: "POST",
      body: JSON.stringify({ mode: mode === "winERemove" ? "remove" : "install" })
    });
    document.getElementById("integration-output").textContent = JSON.stringify(result, null, 2);
    await syncStateAndChrome();
    return;
  }

  if (mode === "folderDefault") {
    const ok = confirm(
      "Back up current shell settings, then set Explore Better as the current-user default folder and drive open handler?"
    );
    if (!ok) return;
  } else if (mode === "contextMenu") {
    const ok = confirm("Back up current shell settings, then install the current-user Explore Better context menu?");
    if (!ok) return;
  }

  const result = await request("/api/integration/apply", {
    method: "POST",
    body: JSON.stringify({ mode })
  });
  document.getElementById("integration-output").textContent = JSON.stringify(result, null, 2);
  await syncStateAndChrome();
}

async function updateIntegrationSetting(key, value) {
  const nextSettings = { ...(app.state.settings || {}) };
  if (key === "launchMode") {
    nextSettings.launchMode = normalizeLaunchMode(value);
  } else if (key === "shellOpenMode") {
    nextSettings.shellOpenMode = normalizeShellOpenMode(value);
  }
  app.state.settings = {
    ...nextSettings
  };
  await saveStateNow();
  applyAppSettingsChrome();
  renderPreferencesDialog();
  renderBackupDialog();
  const output = document.getElementById("integration-output");
  if (app.state.integration?.generatedAt) {
    const result = await request("/api/integration/generate", { method: "POST" });
    output.textContent = JSON.stringify(result, null, 2);
    await syncStateAndChrome();
    showToast("Integration setting saved and files regenerated");
    return;
  }
  renderIntegration();
  showToast("Integration setting saved");
}

function isTypingTarget(target) {
  const element = target instanceof Element ? target : null;
  return Boolean(element?.closest("input, textarea, select, [contenteditable='true']"));
}

function paneFromEventTarget(target) {
  const element = target instanceof Element ? target : null;
  const list = element?.closest("[data-list]");
  if (isPaneName(list?.dataset.list)) {
    return list.dataset.list;
  }
  const pane = element?.closest(".pane[data-pane]");
  if (isPaneName(pane?.dataset.pane)) {
    return pane.dataset.pane;
  }
  return app.activePane;
}

function listHasKeyboardFocus(event) {
  const activeList = document.activeElement?.closest?.("[data-list]");
  const eventList = event.target instanceof Element ? event.target.closest("[data-list]") : null;
  return Boolean(activeList || eventList);
}

async function handleDesktopShortcutAction(action) {
  if (document.querySelector("dialog[open]")) {
    return false;
  }
  const paneName = isPaneName(app.activePane) ? app.activePane : "left";
  if (action === "duplicate-tab") {
    duplicateTab(paneName);
    return true;
  }
  if (action === "close-tab") {
    closeTab(paneName);
    return true;
  }
  if (action === "next-tab") {
    await cyclePaneTab(paneName, 1);
    return true;
  }
  if (action === "previous-tab") {
    await cyclePaneTab(paneName, -1);
    return true;
  }
  if (action === "reopen-tab") {
    await reopenClosedTab(paneName);
    return true;
  }
  return false;
}

async function handlePaneShortcut(event) {
  if (document.querySelector("dialog[open]") || isTypingTarget(event.target)) {
    return false;
  }
  if (event.target.closest?.("button, a, select, summary, [role='button'], [role='menuitem'], [role='tab']")) {
    return false;
  }

  const paneName = paneFromEventTarget(event.target);
  if (!isPaneName(paneName)) {
    return false;
  }
  app.activePane = paneName;
  updateActivePaneChrome();

  const key = event.key;
  const lowerKey = key.toLowerCase();
  const hasOnlyCtrl = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
  const hasCtrlShift = (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey;
  const hasNoModifier = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  const inList = listHasKeyboardFocus(event);

  if (hasCtrlShift && ["Digit1", "Digit2", "Digit3"].includes(event.code)) {
    event.preventDefault();
    setPaneLayout(event.code === "Digit1" ? "vertical" : event.code === "Digit2" ? "horizontal" : "single");
    return true;
  }
  if (hasCtrlShift && lowerKey === "m") {
    event.preventDefault();
    openSelectMaskDialog(paneName);
    return true;
  }
  if (hasCtrlShift && lowerKey === "t") {
    event.preventDefault();
    await reopenClosedTab(paneName);
    return true;
  }
  if (hasCtrlShift && (lowerKey === "tab" || key === "PageUp")) {
    event.preventDefault();
    await cyclePaneTab(paneName, -1);
    return true;
  }

  if (hasOnlyCtrl && lowerKey === "t") {
    event.preventDefault();
    duplicateTab(paneName);
    return true;
  }
  if (hasOnlyCtrl && lowerKey === "w") {
    event.preventDefault();
    closeTab(paneName);
    return true;
  }
  if (hasOnlyCtrl && (lowerKey === "tab" || key === "PageDown")) {
    event.preventDefault();
    await cyclePaneTab(paneName, 1);
    return true;
  }
  if (hasOnlyCtrl && key === "PageUp") {
    event.preventDefault();
    await cyclePaneTab(paneName, -1);
    return true;
  }
  if (hasOnlyCtrl && lowerKey === "a") {
    event.preventDefault();
    selectAll(paneName);
    return true;
  }
  if (hasOnlyCtrl && lowerKey === "c") {
    event.preventDefault();
    await copySelectionToClipboard(paneName);
    return true;
  }
  if (hasOnlyCtrl && lowerKey === "x") {
    event.preventDefault();
    await cutSelectionToClipboard(paneName);
    return true;
  }
  if (hasOnlyCtrl && lowerKey === "v") {
    event.preventDefault();
    await pasteFileClipboard(paneName);
    focusPaneList(paneName);
    return true;
  }
  if (hasOnlyCtrl && lowerKey === "i") {
    event.preventDefault();
    invertSelection(paneName);
    return true;
  }
  if (hasOnlyCtrl && lowerKey === "l") {
    event.preventDefault();
    focusPathInput(paneName);
    return true;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && lowerKey === "l") {
    event.preventDefault();
    await openLabelsDialog(paneName);
    return true;
  }
  if (hasOnlyCtrl && lowerKey === "f") {
    event.preventDefault();
    openQuickSearch(paneName, "filter");
    return true;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && lowerKey === "v") {
    event.preventDefault();
    cycleViewMode(paneName);
    focusPaneList(paneName);
    return true;
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && key === "ArrowLeft") {
    event.preventDefault();
    await goBack(paneName);
    focusPaneList(paneName);
    return true;
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && key === "ArrowRight") {
    event.preventDefault();
    await goForward(paneName);
    focusPaneList(paneName);
    return true;
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && key === "ArrowDown") {
    event.preventDefault();
    openPaneHistoryDialog(paneName);
    return true;
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && key === "Enter") {
    event.preventDefault();
    await openWindowsProperties(paneName);
    return true;
  }
  if (hasNoModifier && key === "Backspace") {
    event.preventDefault();
    clearTypeahead();
    await goUp(paneName);
    focusPaneList(paneName);
    return true;
  }
  if (hasOnlyCtrl && key === "Enter") {
    event.preventDefault();
    clearTypeahead();
    await openFocusedOrSelectedInNewTab(paneName);
    return true;
  }
  if (hasNoModifier && key === "Enter") {
    event.preventDefault();
    clearTypeahead();
    await openFocusedOrSelected(paneName);
    return true;
  }
  if (hasNoModifier && key === "F2") {
    event.preventDefault();
    await renameSelected(paneName);
    return true;
  }
  if (hasNoModifier && key === "F3") {
    event.preventDefault();
    await openViewer(paneName);
    return true;
  }
  if (hasNoModifier && key === "F5") {
    event.preventDefault();
    await copyToOther(paneName);
    return true;
  }
  if (hasNoModifier && key === "F6") {
    event.preventDefault();
    await moveToOther(paneName);
    return true;
  }
  if (hasOnlyCtrl && key === "Delete") {
    event.preventDefault();
    await recycleSelected(paneName);
    return true;
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey && event.shiftKey && key === "Delete") {
    event.preventDefault();
    await deleteSelectedPermanently(paneName);
    return true;
  }
  if (hasNoModifier && key === "Delete") {
    event.preventDefault();
    await trashSelected(paneName);
    return true;
  }
  if (hasNoModifier && key === "Escape") {
    event.preventDefault();
    clearTypeahead();
    clearSelection(paneName);
    return true;
  }

  if (!inList) {
    return false;
  }

  if (key === "ArrowDown") {
    event.preventDefault();
    focusEntryByDelta(paneName, 1, {
      extend: event.shiftKey,
      preserveSelection: event.ctrlKey || event.metaKey
    });
    return true;
  }
  if (key === "ArrowUp") {
    event.preventDefault();
    focusEntryByDelta(paneName, -1, {
      extend: event.shiftKey,
      preserveSelection: event.ctrlKey || event.metaKey
    });
    return true;
  }
  if (key === "Home") {
    event.preventDefault();
    focusEntryAtIndex(paneName, 0, {
      extend: event.shiftKey,
      preserveSelection: event.ctrlKey || event.metaKey
    });
    return true;
  }
  if (key === "End") {
    event.preventDefault();
    focusEntryAtIndex(paneName, visibleEntries(paneName).length - 1, {
      extend: event.shiftKey,
      preserveSelection: event.ctrlKey || event.metaKey
    });
    return true;
  }
  if (key === "PageDown") {
    event.preventDefault();
    focusEntryByDelta(paneName, pageStepForPane(paneName), {
      extend: event.shiftKey,
      preserveSelection: event.ctrlKey || event.metaKey
    });
    return true;
  }
  if (key === "PageUp") {
    event.preventDefault();
    focusEntryByDelta(paneName, -pageStepForPane(paneName), {
      extend: event.shiftKey,
      preserveSelection: event.ctrlKey || event.metaKey
    });
    return true;
  }
  if (tabOf(paneName).viewMode === "tiles" && key === "ArrowRight") {
    event.preventDefault();
    focusEntryByDelta(paneName, 1, {
      extend: event.shiftKey,
      preserveSelection: event.ctrlKey || event.metaKey
    });
    return true;
  }
  if (tabOf(paneName).viewMode === "tiles" && key === "ArrowLeft") {
    event.preventDefault();
    focusEntryByDelta(paneName, -1, {
      extend: event.shiftKey,
      preserveSelection: event.ctrlKey || event.metaKey
    });
    return true;
  }
  if (event.code === "Space") {
    const focusedPath = tabOf(paneName).focusedPath;
    if (focusedPath) {
      event.preventDefault();
      clearTypeahead();
      selectEntry(paneName, focusedPath, { ctrlKey: true });
      return true;
    }
  }
  if (handleTypeaheadKey(event, paneName)) {
    return true;
  }

  return false;
}

async function openCommandDialog() {
  if (!app.state) {
    await loadState();
  }
  const dialog = document.getElementById("command-dialog");
  const input = document.getElementById("command-input");
  loadCommandCenterState();
  dialog.showModal();
  input.value = "";
  app.commandPalette.view = "all";
  app.commandPalette.activeIndex = 0;
  updateCommandCenterViewButtons();
  renderCommands("");
  input.focus();
}

function speedPaneName() {
  return isPaneName(app.speed.paneName) ? app.speed.paneName : app.activePane;
}

function speedPath() {
  return tabOf(speedPaneName()).path;
}

function clearSpeedPoll() {
  if (app.speed.pollTimer) {
    clearTimeout(app.speed.pollTimer);
    app.speed.pollTimer = null;
  }
}

function clearBackgroundSpeedPoll() {
  if (app.speed.backgroundPollTimer) {
    clearTimeout(app.speed.backgroundPollTimer);
    app.speed.backgroundPollTimer = null;
  }
}

function speedBackgroundCaps() {
  const maxFolders = Number(document.getElementById("speed-bg-max-folders")?.value || 500);
  const maxEntries = Number(document.getElementById("speed-bg-max-entries")?.value || 100000);
  const contentKb = Number(document.getElementById("speed-bg-content-kb")?.value || 128);
  return {
    maxFolders: Math.max(1, Math.min(Number.isFinite(maxFolders) ? Math.round(maxFolders) : 500, 5000)),
    maxEntries: Math.max(100, Math.min(Number.isFinite(maxEntries) ? Math.round(maxEntries) : 100000, 500000)),
    maxContentBytes: Math.max(1024, Math.min(Number.isFinite(contentKb) ? Math.round(contentKb * 1024) : 128000, 1_000_000))
  };
}

function speedMetricId(label) {
  return String(label || "metric")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "metric";
}

function pushSpeedMetric(cells, label, value, kind = "") {
  if (value === null || value === undefined || value === "") {
    return;
  }
  cells.push({ label, value: String(value), kind });
}

function timingValue(timing, key) {
  const value = Number(timing?.[key]);
  return Number.isFinite(value) ? formatMilliseconds(value) : "";
}

function speedLivePaneSnapshot() {
  const paneName = speedPaneName();
  const tab = tabOf(paneName);
  const visibleCount = visibleEntryData(tab).entries.length;
  const totalCount = tab.entries.length;
  const timing = tab.lastLoadTiming || null;
  const source =
    timing?.cached === true
      ? "Memory cache"
      : timing?.source === "zip" || tab.virtualMode === "zip"
        ? "ZIP"
        : "Filesystem";
  return { paneName, tab, visibleCount, totalCount, timing, source };
}

function speedLivePaneMetrics() {
  const { paneName, tab, visibleCount, totalCount, timing, source } = speedLivePaneSnapshot();
  const cells = [];
  pushSpeedMetric(cells, "Active Pane", paneName, "live");
  pushSpeedMetric(cells, "Pane Items", visibleCount === totalCount ? totalCount : `${visibleCount}/${totalCount}`, "live");
  pushSpeedMetric(cells, "Source", source, "live");
  pushSpeedMetric(cells, "Live Load", timingValue(timing, "totalMs"), "live");
  const readStat = [timingValue(timing, "readMs"), timingValue(timing, "statMs")].filter(Boolean);
  pushSpeedMetric(cells, "Read/Stat", readStat.length ? readStat.join(" / ") : "", "live");
  const filterLabels = [timingValue(timing, "filterMs"), timingValue(timing, "labelMs")].filter(Boolean);
  pushSpeedMetric(cells, "Filter/Labels", filterLabels.length ? filterLabels.join(" / ") : "", "live");
  const scanned = Number.isFinite(Number(timing?.scanned)) ? `${Number(timing.scanned).toLocaleString()} scanned` : "";
  const workers = Number.isFinite(Number(timing?.concurrency)) ? `${timing.concurrency} workers` : "";
  pushSpeedMetric(cells, "Scanned/Workers", [scanned, workers].filter(Boolean).join(" / "), "live");
  const metadata = [
    tab.listingIncludesDimensions ? "Dim" : "",
    tab.listingIncludesLinks ? "Links" : "",
    tab.listingIncludesAttributes ? "Attr" : "",
    tab.folderSignature ? "Signature" : ""
  ].filter(Boolean);
  pushSpeedMetric(cells, "Metadata", metadata.length ? metadata.join(" / ") : "Lean", "live");
  return cells;
}

function speedSummaryText() {
  const status = app.speed.status;
  const job = status?.job;
  if (job?.status === "running") {
    return "Indexing...";
  }
  if (job?.status === "error") {
    return `Index failed: ${job.error}`;
  }
  if (status?.index) {
    return `${status.index.count} items / ${status.index.buildMs || 0} ms build`;
  }
  const liveLoad = timingValue(speedLivePaneSnapshot().timing, "totalMs");
  return liveLoad ? `Not indexed / live ${liveLoad}` : "Not indexed";
}

function backgroundIndexRunningCount() {
  return (app.speed.background?.roots || []).filter((root) => root.job?.status === "running").length;
}

function speedMetricsHtml() {
  const status = app.speed.status;
  const search = app.speed.search;
  const background = app.speed.background;
  const backgroundSearch = app.speed.backgroundSearch;
  const index = status?.index || search?.index;
  const cells = speedLivePaneMetrics();
  if (index) {
    pushSpeedMetric(cells, "Indexed", `${index.count} items`);
    pushSpeedMetric(cells, "Built", index.builtAt ? formatDate(index.builtAt) : "Unknown");
    pushSpeedMetric(cells, "Image Meta", index.includeDimensions ? "Warmed" : "Skipped");
    if (index.includeLinks) {
      pushSpeedMetric(cells, "Links", "Warmed");
    }
    if (index.dimensionsCache) {
      const cache = index.dimensionsCache;
      pushSpeedMetric(cells, "Dim Cache", `${cache.hits || 0} hit / ${cache.misses || 0} miss`);
      if (cache.updates || cache.pruned) {
        pushSpeedMetric(cells, "Dim Writes", `${cache.updates || 0} updates / ${cache.pruned || 0} pruned`);
      }
    }
    pushSpeedMetric(cells, "List", `${index.listTiming?.totalMs || 0} ms`);
    pushSpeedMetric(cells, "Build", `${index.buildMs || 0} ms`);
  }
  if (search?.timing) {
    pushSpeedMetric(cells, "Search", `${search.timing.searchMs || 0} ms`);
    pushSpeedMetric(cells, "Scanned", `${search.timing.scanned || 0}`);
    pushSpeedMetric(cells, "Returned", `${search.timing.returned || search.results?.length || 0}`);
  }
  if (background?.roots) {
    const roots = background.roots || [];
    const totalItems = roots.reduce(
      (sum, root) => sum + Number(root.search?.count || root.manifest?.count || root.lastStats?.count || 0),
      0
    );
    const totalContent = roots.reduce(
      (sum, root) =>
        sum + Number(root.search?.contentIndexed || root.manifest?.contentIndexed || root.lastStats?.contentIndexed || 0),
      0
    );
    pushSpeedMetric(cells, "BG Roots", `${roots.length}`);
    pushSpeedMetric(cells, "BG Items", `${totalItems}`);
    if (totalContent) {
      pushSpeedMetric(cells, "BG Text", `${totalContent} file(s)`);
    }
    const running = backgroundIndexRunningCount();
    if (running) {
      pushSpeedMetric(cells, "BG Running", `${running}`);
    }
    const watched = roots.reduce((sum, root) => sum + Number(root.watcher?.watchedFolders || 0), 0);
    if (watched) {
      pushSpeedMetric(cells, "BG Watched", `${watched}`);
    }
    const stale = roots.filter((root) => root.freshness?.stale).length;
    if (stale) {
      pushSpeedMetric(cells, "BG Stale", `${stale}`, "warn");
    }
  }
  if (backgroundSearch?.timing) {
    pushSpeedMetric(cells, "BG Search", `${backgroundSearch.timing.searchMs || 0} ms`);
    pushSpeedMetric(cells, "BG Scanned", `${backgroundSearch.timing.scanned || 0}`);
    pushSpeedMetric(cells, "BG Returned", `${backgroundSearch.timing.returned || backgroundSearch.results?.length || 0}`);
  }
  if (!cells.length) {
    return `<div class="empty-state">Build an index to create a warm metadata cache for this folder.</div>`;
  }
  return cells
    .map(
      (cell) => `<div class="${cell.kind ? `speed-metric-${escapeHtml(cell.kind)}` : ""}" data-speed-metric="${escapeHtml(
        speedMetricId(cell.label)
      )}"><span>${escapeHtml(cell.label)}</span><strong>${escapeHtml(cell.value)}</strong></div>`
    )
    .join("");
}

function speedResultMarkup(result) {
  const meta = [
    result.rootName || "",
    result.matchSource === "content" ? "Content" : "",
    result.kind || (result.isDirectory ? "Folder" : "File"),
    result.isFile ? formatSize(result.size) : "",
    result.modified ? formatDate(result.modified) : "",
    result.labelName || ""
  ].filter(Boolean);
  return `<button type="button" data-speed-open="${escapeHtml(result.path)}" title="${escapeHtml(result.path)}">
    <strong>${escapeHtml(result.name || labelForPath(result.path))}</strong>
    <span>${escapeHtml(meta.join(" / "))}</span>
    ${result.matchSnippet ? `<span>${escapeHtml(result.matchSnippet)}</span>` : ""}
  </button>`;
}

function speedBackgroundRootMarkup(root) {
  const running = root.job?.status === "running";
  const autoRebuild = root.autoRebuild || root.freshness?.autoRebuild || null;
  const watcher = root.watcher || null;
  const stats = root.search || root.manifest || root.lastStats || {};
  const progress = root.job?.progress;
  const meta = [
    running
      ? `${progress?.indexedFolders || 0} folders / ${progress?.indexedEntries || 0} items${
          progress?.indexedContent ? ` / ${progress.indexedContent} text` : ""
        }`
      : stats.count !== undefined
        ? `${stats.folders || 0} folders / ${stats.count || 0} items${
            stats.contentIndexed ? ` / ${stats.contentIndexed} text` : ""
          }`
        : "No cache",
    stats.builtAt ? formatDate(stats.builtAt) : root.lastCompletedAt ? formatDate(root.lastCompletedAt) : "",
    root.freshness?.stale ? `Stale: ${root.freshness.reason || "changed"}` : root.freshness?.status === "fresh" ? "Fresh" : "",
    autoRebuild?.scheduled
      ? "Auto rebuild started"
      : autoRebuild?.active
        ? "Auto rebuild running"
        : autoRebuild?.skipped === "cooldown"
          ? "Auto rebuild cooling down"
          : "",
    watcher?.watchedFolders
      ? `Watching ${watcher.watchedFolders} folder${watcher.watchedFolders === 1 ? "" : "s"}${
          watcher.eventCount ? ` / ${watcher.eventCount} event${watcher.eventCount === 1 ? "" : "s"}` : ""
        }`
      : watcher?.enabled && watcher.available === false
        ? "Watch unavailable"
        : "",
    stats.truncated ? "Truncated" : "",
    watcher?.error ? `Watch: ${watcher.error}` : "",
    root.lastError ? `Error: ${root.lastError}` : ""
  ].filter(Boolean);
  return `<div class="speed-bg-row${running ? " running" : ""}">
    <div>
      <strong>${escapeHtml(root.name || labelForPath(root.path))}</strong>
      <span title="${escapeHtml(root.path)}">${escapeHtml(root.path)}</span>
      <small>${escapeHtml(meta.join(" / "))}</small>
    </div>
    <div class="speed-bg-actions">
      <button type="button" data-speed-bg-action="start" data-speed-bg-id="${escapeHtml(root.id)}" ${
        running ? "disabled" : ""
      }>${running ? "Running" : "Start"}</button>
      <button type="button" data-speed-bg-action="stop" data-speed-bg-id="${escapeHtml(root.id)}" ${
        running ? "" : "disabled"
      }>Stop</button>
      <button type="button" data-speed-bg-action="remove" data-speed-bg-id="${escapeHtml(root.id)}">Remove</button>
    </div>
  </div>`;
}

function speedBackgroundHtml() {
  const roots = app.speed.background?.roots || [];
  if (!roots.length) {
    return `<div class="empty-state">No background roots</div>`;
  }
  return roots.map(speedBackgroundRootMarkup).join("");
}

function renderSpeedDialog(message = "") {
  const pathEl = document.getElementById("speed-path");
  const summary = document.getElementById("speed-summary");
  const metrics = document.getElementById("speed-metrics");
  const results = document.getElementById("speed-results");
  const backgroundList = document.getElementById("speed-background-list");
  if (!pathEl || !summary || !metrics || !results || !backgroundList) {
    return;
  }
  pathEl.textContent = speedPath();
  summary.textContent = message || speedSummaryText();
  backgroundList.innerHTML = speedBackgroundHtml();
  metrics.innerHTML = speedMetricsHtml();
  if (app.speed.backgroundSearch?.indexed === false) {
    results.innerHTML = `<div class="empty-state">No background cache yet</div>`;
  } else if (app.speed.backgroundSearch?.results?.length) {
    results.innerHTML = app.speed.backgroundSearch.results.map(speedResultMarkup).join("");
  } else if (app.speed.backgroundSearch) {
    results.innerHTML = `<div class="empty-state">No background matches</div>`;
  } else if (app.speed.search?.indexed === false) {
    results.innerHTML = `<div class="empty-state">No index yet. Build this folder first.</div>`;
  } else if (app.speed.search?.results?.length) {
    results.innerHTML = app.speed.search.results.map(speedResultMarkup).join("");
  } else if (app.speed.search) {
    results.innerHTML = `<div class="empty-state">No indexed matches</div>`;
  } else {
    results.innerHTML = `<div class="empty-state">Search uses the saved folder index, not a fresh filesystem scan.</div>`;
  }
}

async function refreshBackgroundIndexes() {
  app.speed.background = await request("/api/background-indexes");
  renderSpeedDialog();
  if (backgroundIndexRunningCount()) {
    clearBackgroundSpeedPoll();
    app.speed.backgroundPollTimer = setTimeout(
      () => refreshBackgroundIndexes().catch((error) => renderSpeedDialog(error.message)),
      900
    );
  } else {
    clearBackgroundSpeedPoll();
  }
  return app.speed.background;
}

async function refreshSpeedStatus() {
  const query = new URLSearchParams({ path: speedPath() });
  if (app.speed.jobId) {
    query.set("jobId", app.speed.jobId);
  }
  app.speed.status = await request(`/api/index/status?${query}`);
  if (app.speed.status?.job?.status && app.speed.status.job.status !== "running") {
    app.speed.jobId = null;
    clearSpeedPoll();
  }
  renderSpeedDialog();
  if (app.speed.status?.job?.status === "running") {
    clearSpeedPoll();
    app.speed.pollTimer = setTimeout(() => refreshSpeedStatus().catch((error) => renderSpeedDialog(error.message)), 650);
  }
  return app.speed.status;
}

async function buildSpeedIndex() {
  clearSpeedPoll();
  app.speed.search = null;
  app.speed.backgroundSearch = null;
  renderSpeedDialog("Starting index...");
  const includeDimensions = document.getElementById("speed-index-dimensions")?.checked !== false;
  const includeLinks = document.getElementById("speed-index-links")?.checked === true;
  const response = await request("/api/index/build", {
    method: "POST",
    body: JSON.stringify({
      path: speedPath(),
      showHidden: currentSettings().showHidden,
      includeDimensions,
      includeLinks
    })
  });
  app.speed.jobId = response.job?.id || null;
  app.speed.status = { ...(app.speed.status || {}), job: response.job };
  renderSpeedDialog();
  await refreshSpeedStatus();
}

async function searchSpeedIndex() {
  const queryText = document.getElementById("speed-query")?.value || "";
  const query = new URLSearchParams({ path: speedPath(), q: queryText, limit: "120" });
  app.speed.backgroundSearch = null;
  app.speed.search = await request(`/api/index/search?${query}`);
  renderSpeedDialog();
}

async function startBackgroundIndexForActive() {
  clearBackgroundSpeedPoll();
  app.speed.backgroundSearch = null;
  const includeDimensions = document.getElementById("speed-index-dimensions")?.checked !== false;
  const includeLinks = document.getElementById("speed-index-links")?.checked === true;
  const includeContent = document.getElementById("speed-index-content")?.checked === true;
  const caps = speedBackgroundCaps();
  app.speed.background = await request("/api/background-indexes/start", {
    method: "POST",
    body: JSON.stringify({
      path: speedPath(),
      recursive: true,
      showHidden: currentSettings().showHidden,
      includeDimensions,
      includeLinks,
      includeContent,
      ...caps
    })
  });
  renderSpeedDialog();
  await refreshBackgroundIndexes();
}

async function startBackgroundIndexRoot(rootId) {
  clearBackgroundSpeedPoll();
  app.speed.background = await request("/api/background-indexes/start", {
    method: "POST",
    body: JSON.stringify({ id: rootId })
  });
  renderSpeedDialog();
  await refreshBackgroundIndexes();
}

async function stopBackgroundIndexRoot(rootId) {
  app.speed.background = await request("/api/background-indexes/stop", {
    method: "POST",
    body: JSON.stringify({ id: rootId })
  });
  renderSpeedDialog();
  await refreshBackgroundIndexes();
}

async function removeBackgroundIndexRoot(rootId) {
  clearBackgroundSpeedPoll();
  app.speed.background = await request(`/api/background-indexes?id=${encodeURIComponent(rootId)}`, {
    method: "DELETE"
  });
  app.speed.backgroundSearch = null;
  renderSpeedDialog();
}

async function searchBackgroundIndexesUi() {
  const queryText = document.getElementById("speed-query")?.value || "";
  const query = new URLSearchParams({ q: queryText, limit: "200" });
  app.speed.search = null;
  app.speed.backgroundSearch = await request(`/api/background-indexes/search?${query}`);
  renderSpeedDialog();
}

async function openSpeedDialog(paneName = app.activePane) {
  app.speed.paneName = isPaneName(paneName) ? paneName : app.activePane;
  app.speed.search = null;
  app.speed.backgroundSearch = null;
  const dialog = document.getElementById("speed-dialog");
  dialog.showModal();
  renderSpeedDialog("Checking index...");
  await Promise.all([refreshSpeedStatus(), refreshBackgroundIndexes()]);
  document.getElementById("speed-query")?.focus();
}

function manualInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function manualMarkdownToHtml(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let listOpen = false;
  let codeOpen = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (codeOpen) {
        html.push("</code></pre>");
      } else {
        if (listOpen) {
          html.push("</ul>");
          listOpen = false;
        }
        html.push("<pre><code>");
      }
      codeOpen = !codeOpen;
      continue;
    }
    if (codeOpen) {
      html.push(`${escapeHtml(line)}\n`);
      continue;
    }
    if (!line.trim()) {
      if (listOpen) {
        html.push("</ul>");
        listOpen = false;
      }
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      if (listOpen) {
        html.push("</ul>");
        listOpen = false;
      }
      const level = Math.min(3, heading[1].length);
      html.push(`<h${level}>${manualInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*-\s+(.+)$/);
    if (bullet) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${manualInlineMarkdown(bullet[1])}</li>`);
      continue;
    }
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
    html.push(`<p>${manualInlineMarkdown(line)}</p>`);
  }
  if (codeOpen) {
    html.push("</code></pre>");
  }
  if (listOpen) {
    html.push("</ul>");
  }
  return html.join("");
}

function renderManualDialog() {
  const body = document.getElementById("manual-body");
  const summary = document.getElementById("manual-summary");
  if (!body || !summary) {
    return;
  }
  const query = normalizedTypeaheadText(app.manual.query).trim();
  const source = app.manual.text || "Manual unavailable.";
  const lines = query
    ? source
        .split(/\r?\n/)
        .filter((line) => normalizedTypeaheadText(line).includes(query))
        .join("\n")
    : source;
  body.innerHTML = manualMarkdownToHtml(lines || `# No Matches\n\nNo manual sections matched "${app.manual.query}".`);
  summary.textContent = query ? `Filtered: ${app.manual.query}` : "USER_MANUAL.md";
}

async function loadManualText(force = false) {
  if (!force && app.manual.text) {
    return app.manual.text;
  }
  const result = await request("/api/manual");
  app.manual.text = result.text || "";
  app.manual.loadedAt = Date.now();
  return app.manual.text;
}

async function openManualDialog() {
  const dialog = document.getElementById("manual-dialog");
  const body = document.getElementById("manual-body");
  if (!dialog || !body) {
    return false;
  }
  dialog.showModal();
  body.innerHTML = `<div class="empty-state">Loading manual</div>`;
  try {
    await loadManualText();
    renderManualDialog();
    document.getElementById("manual-search")?.focus();
  } catch (error) {
    body.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
  return true;
}

function commandPaletteHotkeyMap() {
  const map = new Map();
  for (const hotkey of hotkeys()) {
    const key = hotkeyTargetValue(hotkey.targetType, hotkey.targetId);
    const combos = map.get(key) || [];
    combos.push(hotkey.combo);
    map.set(key, combos);
  }
  return map;
}

function commandPaletteItems() {
  const hotkeyMap = commandPaletteHotkeyMap();
  const builtinItems = commands.map((command, index) => {
    const id = builtinCommandId(command, index);
    const key = hotkeyTargetValue("command", id);
    return {
      type: "command",
      id,
      group: "Commands",
      name: command.name,
      detail: command.detail,
      meta: "Built in",
      hotkeys: hotkeyMap.get(key) || [],
      run: command.run
    };
  });
  const toolItems = (app.state?.commands || []).map((tool) => {
    const key = hotkeyTargetValue("tool", tool.id);
    return {
      type: "tool",
      id: tool.id,
      group: "Tools",
      name: tool.name || "Untitled Tool",
      detail: tool.description || tool.kind || "Saved trusted command",
      meta: tool.kind === "cmd" ? "Command Prompt" : "PowerShell",
      hotkeys: hotkeyMap.get(key) || [],
      run: () => runTool(tool.id)
    };
  });
  const scriptItems = (app.state?.scripts || []).map((script) => {
    const key = hotkeyTargetValue("script", script.id);
    return {
      type: "script",
      id: script.id,
      group: "Scripts",
      name: script.name || "Untitled Script",
      detail: script.description || "Saved trusted JavaScript snippet",
      meta: script.showInToolbar ? "Toolbar script" : "Saved script",
      hotkeys: hotkeyMap.get(key) || [],
      run: () => runSavedScript(script.id)
    };
  });
  return [...builtinItems, ...toolItems, ...scriptItems]
    .filter((item) => item.id)
    .map((item) => ({
      ...item,
      key: `${item.type}:${item.id}`,
      category: commandPaletteCategory(item)
    }));
}

function loadCommandCenterState() {
  if (app.commandPalette.loaded) return;
  app.commandPalette.loaded = true;
  try {
    const saved = JSON.parse(localStorage.getItem(commandCenterStorageKey) || "{}");
    const pins = Array.isArray(saved.pins) ? saved.pins.filter((value) => typeof value === "string").slice(0, 64) : [];
    const recents = Array.isArray(saved.recents) ? saved.recents.filter((value) => typeof value === "string").slice(0, 12) : [];
    app.commandPalette.pins = new Set(pins);
    app.commandPalette.recents = [...new Set(recents)];
  } catch {
    app.commandPalette.pins = new Set();
    app.commandPalette.recents = [];
  }
}

function saveCommandCenterState() {
  try {
    localStorage.setItem(
      commandCenterStorageKey,
      JSON.stringify({ pins: [...app.commandPalette.pins].slice(0, 64), recents: app.commandPalette.recents.slice(0, 12) })
    );
  } catch {
    // Command history is an optional convenience and must never block execution.
  }
}

function commandPaletteCategory(item) {
  if (item.type === "tool" || item.type === "script") return "Automation";
  const text = `${item.name} ${item.detail}`.toLowerCase();
  const rules = [
    ["Transfer & safety", /\b(copy|move|transfer|paste|cut|delete|recycle|trash|sync|archive|zip|extract|send|restore|undo|retry)\b/],
    ["Create & edit", /\b(new|create|rename|edit|attributes|timestamps|shortcut|link|duplicate|bulk rename)\b/],
    ["Find & select", /\b(search|find|filter|select|label|collection|checksum|compare|flat|duplicate files)\b/],
    ["View & layout", /\b(view|tiles|compact|details|preview|hidden|columns|format|sort|split|pane|focus workspace|layout)\b/],
    ["Navigate", /\b(open|tab|favorite|root|history|navigate|location|path|home|documents|downloads)\b/],
    ["System & settings", /\b(preference|toolbar|hotkey|backup|integrat|shell|manual|operation|speed index|cache|diagnostic)\b/]
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || "Utilities";
}

function fuzzySubsequenceScore(text, needle) {
  if (!needle) return 1;
  let cursor = 0;
  let first = -1;
  let gaps = 0;
  for (const character of needle) {
    const position = text.indexOf(character, cursor);
    if (position < 0) return 0;
    if (first < 0) first = position;
    gaps += position - cursor;
    cursor = position + 1;
  }
  return Math.max(1, 180 - first * 2 - gaps);
}

function commandPaletteScore(item, query) {
  const nameText = item.name.toLowerCase();
  const compactName = nameText.replace(/\s+/g, "");
  const text = `${item.name} ${item.detail} ${item.group} ${item.category} ${item.meta} ${item.hotkeys.join(" ")}`.toLowerCase();
  const compactText = text.replace(/\s+/g, "");
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return 1;
  }
  const parts = needle.split(/\s+/).filter(Boolean);
  const partScores = parts.map((part) => {
    if (nameText.includes(part)) return 180 + part.length * 5;
    if (text.includes(part)) return 120 + part.length * 4;
    const compactPart = part.replace(/\s+/g, "");
    const nameScore = fuzzySubsequenceScore(compactName, compactPart);
    if (nameScore > 0) return nameScore;
    return compactPart.length >= 4 ? Math.round(fuzzySubsequenceScore(compactText, compactPart) * 0.5) : 0;
  });
  if (partScores.some((score) => score <= 0)) return 0;
  if (nameText === needle) {
    return 1000;
  }
  if (nameText.startsWith(needle)) {
    return 800;
  }
  if (nameText.includes(needle)) {
    return 600;
  }
  return partScores.reduce((total, score) => total + score, 0);
}

function commandPaletteFilteredItems(query) {
  loadCommandCenterState();
  const needle = query.trim();
  const recentRank = new Map(app.commandPalette.recents.map((key, index) => [key, index]));
  const categoryRank = new Map([
    ["Transfer & safety", 0],
    ["Navigate", 1],
    ["Find & select", 2],
    ["Create & edit", 3],
    ["View & layout", 4],
    ["Automation", 5],
    ["System & settings", 6],
    ["Utilities", 7]
  ]);
  return commandPaletteItems()
    .map((item) => ({ ...item, score: commandPaletteScore(item, query) }))
    .filter((item) => item.score > 0)
    .filter((item) => app.commandPalette.view !== "pinned" || app.commandPalette.pins.has(item.key))
    .filter((item) => app.commandPalette.view !== "recent" || recentRank.has(item.key))
    .map((item) => ({
      ...item,
      pinned: app.commandPalette.pins.has(item.key),
      recentIndex: recentRank.get(item.key) ?? Number.MAX_SAFE_INTEGER
    }))
    .sort((left, right) => {
      if (needle && right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      if (left.recentIndex !== right.recentIndex) return left.recentIndex - right.recentIndex;
      const categoryDiff = (categoryRank.get(left.category) ?? 9) - (categoryRank.get(right.category) ?? 9);
      if (categoryDiff !== 0) return categoryDiff;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    })
    .map((item) => ({
      ...item,
      displayGroup:
        app.commandPalette.view === "recent"
          ? "Recent"
          : app.commandPalette.view === "pinned" || (!needle && item.pinned)
          ? "Pinned"
          : !needle && item.recentIndex !== Number.MAX_SAFE_INTEGER
            ? "Recent"
            : item.category
    }))
    .slice(0, 160);
}

function commandPaletteItemMarkup(item, index, previousGroup) {
  const groupHeading = item.displayGroup !== previousGroup ? `<div class="command-group-heading">${escapeHtml(item.displayGroup)}</div>` : "";
  const hotkeyMarkup = item.hotkeys.length
    ? `<span class="command-hotkeys">${item.hotkeys.map((combo) => `<kbd>${escapeHtml(combo)}</kbd>`).join("")}</span>`
    : "";
  const active = index === app.commandPalette.activeIndex ? " active" : "";
  const pinLabel = item.pinned ? `Unpin ${item.name}` : `Pin ${item.name}`;
  return `${groupHeading}<div class="command-row${active}" role="option" aria-selected="${index === app.commandPalette.activeIndex}">
    <button class="command-item${active}" data-palette-index="${index}">
      <span class="command-item-main">
        <span>${escapeHtml(item.name)}</span>
        ${hotkeyMarkup}
      </span>
      <small>${escapeHtml(item.detail)}</small>
      <span class="command-item-meta"><span>${escapeHtml(item.category)}</span><span>${escapeHtml(item.meta)}</span></span>
    </button>
    <button type="button" class="command-pin${item.pinned ? " pinned" : ""}" data-command-pin="${escapeHtml(item.key)}" title="${escapeHtml(pinLabel)}" aria-label="${escapeHtml(pinLabel)}"></button>
  </div>`;
}

function updateCommandCenterViewButtons() {
  document.querySelectorAll("[data-command-view]").forEach((button) => {
    const active = button.dataset.commandView === app.commandPalette.view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function toggleCommandPalettePin(key) {
  if (!key) return;
  if (app.commandPalette.pins.has(key)) app.commandPalette.pins.delete(key);
  else app.commandPalette.pins.add(key);
  saveCommandCenterState();
  renderCommands(document.getElementById("command-input")?.value || "");
}

function recordCommandPaletteRecent(key) {
  app.commandPalette.recents = [key, ...app.commandPalette.recents.filter((item) => item !== key)].slice(0, 12);
  saveCommandCenterState();
}

function renderCommands(query) {
  const results = document.getElementById("command-results");
  const visible = commandPaletteFilteredItems(query);
  app.commandPalette.items = visible;
  app.commandPalette.activeIndex = Math.max(0, Math.min(app.commandPalette.activeIndex || 0, visible.length - 1));
  if (!visible.length) {
    results.innerHTML = `<div class="empty-state">No matching commands, tools, or scripts</div>`;
    document.getElementById("command-result-summary").textContent = "0 results";
    return;
  }
  document.getElementById("command-result-summary").textContent = `${visible.length} result${visible.length === 1 ? "" : "s"}`;
  let previousGroup = "";
  results.innerHTML = visible
    .map((item, index) => {
      const markup = commandPaletteItemMarkup(item, index, previousGroup);
      previousGroup = item.displayGroup;
      return markup;
    })
    .join("");
  scrollCommandPaletteActiveIntoView();
}

function scrollCommandPaletteActiveIntoView() {
  const active = document.querySelector(".command-item.active");
  if (active) {
    active.scrollIntoView({ block: "nearest" });
  }
}

function moveCommandPaletteSelection(delta) {
  const count = app.commandPalette.items.length;
  if (!count) {
    return;
  }
  app.commandPalette.activeIndex = (app.commandPalette.activeIndex + delta + count) % count;
  renderCommands(document.getElementById("command-input")?.value || "");
}

async function runCommandPaletteItem(index = app.commandPalette.activeIndex) {
  const item = app.commandPalette.items[index];
  if (!item) {
    return;
  }
  const dialog = document.getElementById("command-dialog");
  recordCommandPaletteRecent(item.key);
  if (dialog?.open) {
    dialog.close();
  }
  await item.run();
}

async function handleCommandPaletteKey(event) {
  if (event.ctrlKey && event.key.toLowerCase() === "d") {
    event.preventDefault();
    toggleCommandPalettePin(app.commandPalette.items[app.commandPalette.activeIndex]?.key);
    return true;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveCommandPaletteSelection(1);
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveCommandPaletteSelection(-1);
    return true;
  }
  if (event.key === "Home") {
    event.preventDefault();
    app.commandPalette.activeIndex = 0;
    renderCommands(event.target.value);
    return true;
  }
  if (event.key === "End") {
    event.preventDefault();
    app.commandPalette.activeIndex = Math.max(0, app.commandPalette.items.length - 1);
    renderCommands(event.target.value);
    return true;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    await runCommandPaletteItem();
    return true;
  }
  return false;
}

function packageableScript(snippet) {
  return {
    id: String(snippet?.id || crypto.randomUUID()),
    name: String(snippet?.name || "Untitled Script").trim().slice(0, 80),
    description: String(snippet?.description || "").trim().slice(0, 240),
    code: String(snippet?.code || "").slice(0, 12000),
    showInToolbar: Boolean(snippet?.showInToolbar),
    updatedAt: snippet?.updatedAt || new Date().toISOString()
  };
}

function defaultScriptDraft() {
  return {
    id: "",
    name: "New Script",
    description: "Trusted JavaScript snippet",
    showInToolbar: true,
    code: app.scriptTemplate
  };
}

function currentScript() {
  const scripts = app.state?.scripts || [];
  return scripts.find((snippet) => snippet.id === app.activeScriptId) || scripts[0] || null;
}

function fillScriptForm(snippet = null) {
  const draft = snippet || defaultScriptDraft();
  document.getElementById("script-id").value = draft.id || "";
  document.getElementById("script-name").value = draft.name || "New Script";
  document.getElementById("script-description").value = draft.description || "";
  document.getElementById("script-toolbar").checked = Boolean(draft.showInToolbar);
  document.getElementById("script-code").value = draft.code || app.scriptTemplate;
}

function updateScriptPackageSummary(message = null) {
  const summary = document.getElementById("script-package-summary");
  if (!summary) {
    return;
  }
  const count = app.state?.scripts?.length || 0;
  summary.textContent = message || `${count} saved script${count === 1 ? "" : "s"} ready for package export.`;
}

function renderScriptLibrary() {
  const list = document.getElementById("script-list");
  if (!list) {
    return;
  }
  const scripts = app.state?.scripts || [];
  if (!app.activeScriptId && scripts[0]) {
    app.activeScriptId = scripts[0].id;
  }
  const active = currentScript();
  document.getElementById("script-summary").textContent = `${scripts.length} saved`;
  list.innerHTML = scripts.length
    ? scripts
        .map(
          (snippet) =>
            `<button class="${snippet.id === active?.id ? "active" : ""}" data-select-script="${escapeHtml(
              snippet.id
            )}">
              <span>${escapeHtml(snippet.name)}</span>
              <small>${escapeHtml(snippet.description || formatDate(snippet.updatedAt))}${
                snippet.showInToolbar ? " / toolbar" : ""
              }</small>
            </button>`
        )
        .join("")
    : `<div class="empty-state">No saved scripts</div>`;
  fillScriptForm(active);
  updateScriptPackageSummary();
}

function scriptFromForm() {
  return packageableScript({
    id: document.getElementById("script-id").value || crypto.randomUUID(),
    name: document.getElementById("script-name").value.trim() || "Untitled Script",
    description: document.getElementById("script-description").value.trim(),
    code: document.getElementById("script-code").value,
    showInToolbar: document.getElementById("script-toolbar").checked,
    updatedAt: new Date().toISOString()
  });
}

async function openScriptDialog() {
  await loadState();
  renderScriptLibrary();
  const dialog = document.getElementById("script-dialog");
  dialog.showModal();
  document.getElementById("script-code").focus();
}

async function saveScriptFromForm() {
  const snippet = scriptFromForm();
  const scripts = app.state.scripts || [];
  const index = scripts.findIndex((item) => item.id === snippet.id);
  if (index === -1) {
    scripts.push(snippet);
  } else {
    scripts[index] = snippet;
  }
  app.state.scripts = scripts;
  app.activeScriptId = snippet.id;
  await saveStateNow();
  renderSavedCommandStrip();
  renderScriptLibrary();
  showToast("Script saved");
}

function newScript() {
  app.activeScriptId = null;
  fillScriptForm(defaultScriptDraft());
  document.getElementById("script-output").textContent = "";
}

async function deleteActiveScript() {
  const snippet = currentScript();
  if (!snippet) {
    return;
  }
  if (!confirm(`Delete script "${snippet.name}"?`)) {
    return;
  }
  app.state.scripts = (app.state.scripts || []).filter((item) => item.id !== snippet.id);
  app.activeScriptId = app.state.scripts[0]?.id || null;
  await saveStateNow();
  renderSavedCommandStrip();
  renderScriptLibrary();
  showToast("Script deleted");
}

function scriptPackageFilename() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return `explore-better-scripts-${stamp}.json`;
}

function buildScriptPackage() {
  return {
    schema: "explore-better.scripts.v1",
    app: "Explore Better",
    version: 1,
    exportedAt: new Date().toISOString(),
    scripts: (app.state?.scripts || []).map(packageableScript)
  };
}

function exportScriptPackage() {
  const scriptPackage = buildScriptPackage();
  if (!scriptPackage.scripts.length) {
    updateScriptPackageSummary("No scripts to export.");
    return showToast("No scripts to export");
  }
  const blob = new Blob([`${JSON.stringify(scriptPackage, null, 2)}\n`], {
    type: "application/json"
  });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = scriptPackageFilename();
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  updateScriptPackageSummary(`Exported ${scriptPackage.scripts.length} script(s).`);
  showToast("Script package exported");
}

function scriptsFromPackage(scriptPackage) {
  if (Array.isArray(scriptPackage)) {
    return scriptPackage;
  }
  if (Array.isArray(scriptPackage?.scripts)) {
    return scriptPackage.scripts;
  }
  if (Array.isArray(scriptPackage?.snippets)) {
    return scriptPackage.snippets;
  }
  return [];
}

function normalizeImportedScripts(rawScripts) {
  const seenIds = new Set();
  return rawScripts
    .slice(0, 200)
    .map((source, index) => {
      if (!source || typeof source !== "object") {
        return null;
      }
      const snippet = packageableScript({
        ...source,
        id: source.id || crypto.randomUUID(),
        name: source.name || `Imported Script ${index + 1}`
      });
      if (!snippet.code.trim()) {
        return null;
      }
      if (seenIds.has(snippet.id)) {
        snippet.id = crypto.randomUUID();
      }
      seenIds.add(snippet.id);
      return snippet;
    })
    .filter(Boolean);
}

function mergeImportedScripts(existingScripts, importedScripts, replaceExisting) {
  if (replaceExisting) {
    return {
      scripts: importedScripts,
      added: importedScripts.length,
      updated: 0,
      replaced: existingScripts.length
    };
  }
  const scripts = existingScripts.map(packageableScript);
  const indexById = new Map(scripts.map((snippet, index) => [snippet.id, index]));
  let added = 0;
  let updated = 0;
  for (const snippet of importedScripts) {
    const existingIndex = indexById.get(snippet.id);
    if (existingIndex === undefined) {
      indexById.set(snippet.id, scripts.length);
      scripts.push(snippet);
      added += 1;
    } else {
      scripts[existingIndex] = snippet;
      updated += 1;
    }
  }
  return { scripts, added, updated, replaced: 0 };
}

async function importScriptPackageFile(file) {
  if (!file) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    updateScriptPackageSummary("Import failed: invalid JSON.");
    throw new Error(`Invalid script package JSON: ${error.message}`);
  }
  const importedScripts = normalizeImportedScripts(scriptsFromPackage(parsed));
  if (!importedScripts.length) {
    updateScriptPackageSummary("Import failed: no runnable scripts found.");
    return showToast("No runnable scripts found");
  }
  const replaceExisting = Boolean(document.getElementById("script-import-replace")?.checked);
  const currentCount = app.state?.scripts?.length || 0;
  const verb = replaceExisting ? `replace ${currentCount} saved script(s) with` : "merge";
  if (!confirm(`Import ${importedScripts.length} trusted script(s) and ${verb} this package?`)) {
    updateScriptPackageSummary("Import canceled.");
    return;
  }
  const result = mergeImportedScripts(app.state?.scripts || [], importedScripts, replaceExisting);
  app.state.scripts = result.scripts;
  app.activeScriptId = importedScripts[0]?.id || app.state.scripts[0]?.id || null;
  await saveStateNow();
  renderSavedCommandStrip();
  renderScriptLibrary();
  updateScriptPackageSummary(
    replaceExisting
      ? `Imported ${result.added} script(s), replacing ${result.replaced}.`
      : `Imported ${result.added} new and updated ${result.updated}.`
  );
  showToast("Script package imported");
}

function openScriptPackageFilePicker() {
  const input = document.getElementById("script-package-file");
  if (!input) {
    return;
  }
  input.value = "";
  input.click();
}

function formatScriptRunOutput(result) {
  const eventLines = (result.events || []).map((event) => `event:${event.name} ${JSON.stringify(event.detail ?? null)}`);
  return [
    ...result.logs,
    ...eventLines,
    result.result === undefined ? "" : JSON.stringify(result.result, null, 2)
  ]
    .filter(Boolean)
    .join("\n");
}

async function runScriptCode(code, outputElement = null, metadata = {}) {
  const activePane = app.activePane;
  const activeTab = tabOf(activePane);
  const otherTab = tabOf(otherPane(activePane));
  const leftTab = tabOf("left");
  const rightTab = tabOf("right");
  const result = await request("/api/script", {
    method: "POST",
    body: JSON.stringify({
      code,
      scriptId: metadata.scriptId || null,
      name: metadata.name || metadata.scriptName || "Ad hoc script",
      activePane,
      activePath: activeTab.path,
      otherPath: otherTab.path,
      contextPath: activeTab.path,
      selectedPaths: selectedPaths(activePane),
      panes: {
        left: {
          path: leftTab.path,
          selectedPaths: selectedPaths("left"),
          focusedPath: leftTab.focusedPath || null
        },
        right: {
          path: rightTab.path,
          selectedPaths: selectedPaths("right"),
          focusedPath: rightTab.focusedPath || null
        }
      }
    })
  });
  const text = formatScriptRunOutput(result);
  if (outputElement) {
    outputElement.textContent = text;
  }
  await refreshPane(app.activePane);
  await loadState();
  renderOperations();
  renderSavedCommandStrip();
  return text;
}

async function runSavedScript(scriptId) {
  let snippet = (app.state?.scripts || []).find((item) => item.id === scriptId);
  if (!snippet) {
    await loadState();
    snippet = (app.state?.scripts || []).find((item) => item.id === scriptId);
  }
  if (!snippet) {
    return showToast("Script not found");
  }
  const dialog = document.getElementById("script-dialog");
  const output = dialog?.open ? document.getElementById("script-output") : null;
  if (output) {
    output.textContent = `Running ${snippet.name}...`;
  }
  setStatus(`Running script: ${snippet.name}`);
  try {
    await runScriptCode(snippet.code, output, { scriptId: snippet.id, name: snippet.name });
    showToast(`Script complete: ${snippet.name}`);
  } finally {
    setStatus("Ready");
  }
}

async function runScript() {
  const output = document.getElementById("script-output");
  output.textContent = "Running...";
  await runScriptCode(document.getElementById("script-code").value, output, {
    scriptId: document.getElementById("script-id").value || null,
    name: document.getElementById("script-name").value.trim() || "Ad hoc script"
  });
}

async function handleAction(action, paneName) {
  app.activePane = paneName || app.activePane;
  try {
    if (action === "back") await goBack(paneName);
    if (action === "forward") await goForward(paneName);
    if (action === "history") openPaneHistoryDialog(paneName);
    if (action === "up") await goUp(paneName);
    if (action === "refresh") await refreshPane(paneName);
    if (action === "new-file") openNewFileDialog(paneName);
    if (action === "new-folder") await newFolder(paneName);
    if (action === "rename") await renameSelected(paneName);
    if (action === "bulk-rename") openBulkRenameDialog(paneName);
    if (action === "label") await openLabelsDialog(paneName);
    if (action === "columns") await openColumnsDialog(paneName);
    if (action === "folder-sizes") await calculateFolderSizes(paneName);
    if (action === "format") await openFormatsDialog(paneName);
    if (action === "copy-other") await copyToOther(paneName);
    if (action === "move-other") await moveToOther(paneName);
    if (action === "destination") await openDestinationDialog(paneName);
    if (action === "trash") await trashSelected(paneName);
    if (action === "recycle") await recycleSelected(paneName);
    if (action === "delete") await deleteSelectedPermanently(paneName);
  } catch (error) {
    showToast(error.message);
    setStatus("Error");
  }
}

function wireEvents() {
  document.querySelectorAll(".pane-more").forEach((details) => {
    details.addEventListener("toggle", () => positionPaneMoreMenu(details));
  });
  window.addEventListener("resize", () => {
    document.querySelectorAll(".pane-more[open]").forEach((details) => positionPaneMoreMenu(details));
  });
  window.addEventListener("explore-better-desktop-shortcut", (event) => {
    handleDesktopShortcutAction(event.detail).catch((error) => showToast(error.message));
  });
  window.addEventListener("resize", () => {
    for (const paneName of ["left", "right"]) {
      if (app.virtualLists[paneName]) {
        scheduleVirtualFileRender(paneName);
      }
    }
    if (document.getElementById("size-analysis-dialog")?.open) {
      drawSizeTreemap(app.sizeAnalysis.report);
    }
  });

  document.body.addEventListener("dragstart", (event) => {
    if (handleTabDragStart(event) || handleDockDragStart(event)) {
      return;
    }
    handleEntryDragStart(event);
  });
  document.body.addEventListener("dragend", () => {
    if (app.dragTransfer || app.tabDrag || app.dockDrag) {
      clearDragTransfer();
    }
  });
  document.body.addEventListener("dragenter", (event) => {
    if (handleTabDragOver(event) || handleDockDragOver(event)) {
      return;
    }
    handleEntryDragOver(event);
  });
  document.body.addEventListener("dragover", (event) => {
    if (handleTabDragOver(event) || handleDockDragOver(event)) {
      return;
    }
    handleEntryDragOver(event);
  });
  document.body.addEventListener("dragleave", handleEntryDragLeave);
  document.body.addEventListener("drop", async (event) => {
    if (handleTabDrop(event) || await handleDockDrop(event)) {
      return;
    }
    await handleEntryDrop(event);
  });

  document.body.addEventListener("contextmenu", (event) => {
    openContextMenu(event);
  });

  document.body.addEventListener("pointerover", (event) => {
    const row = event.target.closest?.('[data-entry-kind="directory"]');
    if (!row || row.contains(event.relatedTarget)) {
      return;
    }
    const paneName = row.dataset.pane;
    if (isPaneName(paneName)) {
      prefetchEntryListing(paneName, row.dataset.entryPath, "hover");
    }
  });

  document.body.addEventListener("pointerdown", (event) => {
    const columnGrip = event.target.closest?.("[data-column-resize]");
    if (columnGrip) {
      beginColumnResize(event, columnGrip.dataset.pane, columnGrip.dataset.columnResize);
      return;
    }
    const handle = event.target.closest?.("[data-layout-resize]");
    if (handle) {
      beginLayoutResize(event, handle.dataset.layoutResize);
    }
  });
  window.addEventListener("pointermove", updateColumnResize);
  window.addEventListener("pointerup", finishColumnResize);
  window.addEventListener("pointercancel", finishColumnResize);
  window.addEventListener("pointermove", updateLayoutResize);
  window.addEventListener("pointerup", finishLayoutResize);
  window.addEventListener("pointercancel", finishLayoutResize);

  const sizeTreemap = document.getElementById("size-analysis-treemap");
  if (sizeTreemap) {
    sizeTreemap.addEventListener("pointermove", updateSizeAnalysisTreemapHover);
    sizeTreemap.addEventListener("pointerleave", clearSizeAnalysisTreemapHover);
    sizeTreemap.addEventListener("focus", () => {
      if (!app.sizeAnalysis.treemapHover && app.sizeAnalysis.treemapRects[0]) {
        setSizeAnalysisTreemapHover(app.sizeAnalysis.treemapRects[0]);
      }
    });
    sizeTreemap.addEventListener("blur", clearSizeAnalysisTreemapHover);
    sizeTreemap.addEventListener("click", async (event) => {
      try {
        const hit = sizeAnalysisTreemapRectAtPoint(sizeTreemap, event) || app.sizeAnalysis.treemapHover;
        if (hit) {
          setSizeAnalysisTreemapHover(hit);
          setSizeAnalysisTreemapSelection(hit);
        }
      } catch (error) {
        showToast(error.message);
      }
    });
    sizeTreemap.addEventListener("dblclick", async (event) => {
      try {
        const hit = sizeAnalysisTreemapRectAtPoint(sizeTreemap, event) || app.sizeAnalysis.treemapSelection;
        if (!hit) return;
        setSizeAnalysisTreemapSelection(hit);
        if (hit.treemapGroup) {
          focusSizeAnalysisTreemap(hit.path);
          return;
        }
        await openSizeAnalysisTreemapItem(hit);
      } catch (error) {
        showToast(error.message);
      }
    });
    sizeTreemap.addEventListener("keydown", async (event) => {
      if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        const items = app.sizeAnalysis.treemapRects;
        if (!items.length) return;
        const currentKey = app.sizeAnalysis.treemapSelection?.key || app.sizeAnalysis.treemapHover?.key || "";
        const currentIndex = Math.max(0, items.findIndex((item) => item.key === currentKey));
        const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        const nextIndex = (currentIndex + direction + items.length) % items.length;
        setSizeAnalysisTreemapHover(null);
        setSizeAnalysisTreemapSelection(items[nextIndex]);
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        focusSizeAnalysisTreemapParent();
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        focusSizeAnalysisTreemap("");
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSizeAnalysisTreemapHover(null);
        setSizeAnalysisTreemapSelection(null);
        return;
      }
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        await openSizeAnalysisTreemapItem(app.sizeAnalysis.treemapSelection);
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      try {
        const selected = app.sizeAnalysis.treemapSelection || app.sizeAnalysis.treemapHover || app.sizeAnalysis.treemapRects[0];
        if (selected?.treemapGroup) {
          focusSizeAnalysisTreemap(selected.path);
        } else {
          await openSizeAnalysisTreemapItem(selected);
        }
      } catch (error) {
        showToast(error.message);
      }
    });
  }

  document.getElementById("saved-command-strip").addEventListener("click", async (event) => {
    const runToolButton = event.target.closest("[data-run-tool]");
    const runScriptButton = event.target.closest("[data-run-script]");
    if (!runToolButton && !runScriptButton) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    try {
      if (runToolButton) {
        await runTool(runToolButton.dataset.runTool);
      }
      if (runScriptButton) {
        await runSavedScript(runScriptButton.dataset.runScript);
      }
    } catch (error) {
      const output = document.getElementById("script-dialog")?.open ? document.getElementById("script-output") : null;
      if (output) {
        output.textContent = error.message;
      }
      showToast(error.message);
    }
  });

  document.body.addEventListener("click", async (event) => {
    const paneMoreAction = event.target.closest(".pane-more-menu [data-action]");
    if (paneMoreAction) {
      const menu = paneMoreAction.closest("details");
      if (menu) menu.open = false;
    }
    const pathSuggestionButton = event.target.closest("[data-path-suggest-index]");
    if (pathSuggestionButton) {
      const container = pathSuggestionButton.closest("[data-path-suggest]");
      const paneName = container?.dataset.pathSuggest;
      const pathInput = document.querySelector(`[data-path-input="${paneName}"]`);
      if (pathInput && isPaneName(paneName)) {
        app.pathSuggest.activeIndex = Number(pathSuggestionButton.dataset.pathSuggestIndex) || 0;
        await acceptPathSuggestion(pathInput, { open: true });
      }
      return;
    }
    if (!event.target.closest("[data-path-input], [data-path-suggest]")) {
      hidePathSuggestions();
    }
    if (!event.target.closest("#breadcrumb-menu, [data-breadcrumb-menu-path]")) {
      hideBreadcrumbMenu();
    }
    if (event.target.closest("[data-inline-rename]")) {
      return;
    }
    const contextActionButton = event.target.closest("[data-context-action]");
    if (contextActionButton) {
      await executeContextAction(contextActionButton.dataset.contextAction);
      return;
    }
    if (app.contextMenu && !event.target.closest("#context-menu")) {
      hideContextMenu();
    }

    const dockStatusButton = event.target.closest("[data-dock-status]");
    if (dockStatusButton) {
      if (dockStatusButton.dataset.dockStatus === "selection") {
        focusPaneList(app.activePane);
      }
      if (dockStatusButton.dataset.dockStatus === "operations") {
        await openOpsDialog();
      }
      return;
    }

    const manualActionButton = event.target.closest("[data-manual-action]");
    if (manualActionButton) {
      try {
        const action = manualActionButton.dataset.manualAction;
        if (action === "reload") {
          await loadManualText(true);
          renderManualDialog();
        }
        if (action === "clear-search") {
          app.manual.query = "";
          document.getElementById("manual-search").value = "";
          renderManualDialog();
        }
      } catch (error) {
        showToast(error.message);
      }
      return;
    }

    const speedActionButton = event.target.closest("[data-speed-action]");
    if (speedActionButton) {
      try {
        const action = speedActionButton.dataset.speedAction;
        if (action === "refresh") await refreshSpeedStatus();
        if (action === "build") await buildSpeedIndex();
        if (action === "search") await searchSpeedIndex();
        if (action === "background-refresh") await refreshBackgroundIndexes();
        if (action === "background-add") await startBackgroundIndexForActive();
        if (action === "background-search") await searchBackgroundIndexesUi();
      } catch (error) {
        renderSpeedDialog(error.message);
        showToast(error.message);
      }
      return;
    }

    const speedBackgroundButton = event.target.closest("[data-speed-bg-action]");
    if (speedBackgroundButton) {
      try {
        const action = speedBackgroundButton.dataset.speedBgAction;
        const rootId = speedBackgroundButton.dataset.speedBgId;
        if (action === "start") await startBackgroundIndexRoot(rootId);
        if (action === "stop") await stopBackgroundIndexRoot(rootId);
        if (action === "remove") await removeBackgroundIndexRoot(rootId);
      } catch (error) {
        renderSpeedDialog(error.message);
        showToast(error.message);
      }
      return;
    }

    const speedOpenButton = event.target.closest("[data-speed-open]");
    if (speedOpenButton) {
      try {
        const targetPath = speedOpenButton.dataset.speedOpen;
        const paneName = speedPaneName();
        const entry = [...(app.speed.search?.results || []), ...(app.speed.backgroundSearch?.results || [])].find(
          (item) => samePath(item.path, targetPath)
        );
        if (entry?.isDirectory) {
          await loadPane(paneName, targetPath);
        } else {
          await request("/api/open", {
            method: "POST",
            body: JSON.stringify({ path: targetPath, reveal: true })
          });
        }
        document.getElementById("speed-dialog")?.close();
      } catch (error) {
        renderSpeedDialog(error.message);
        showToast(error.message);
      }
      return;
    }

    const paneTarget = event.target.closest(".pane[data-pane]");
    if (paneTarget && isPaneName(paneTarget.dataset.pane)) {
      app.activePane = paneTarget.dataset.pane;
      updateActivePaneChrome();
    }

    const compactBreadcrumbButton = event.target.closest("[data-compact-breadcrumbs]");
    if (compactBreadcrumbButton) {
      const paneName = compactBreadcrumbButton.dataset.compactBreadcrumbs;
      if (isPaneName(paneName)) {
        event.preventDefault();
        closeCompactBreadcrumbs(paneName);
        toggleCompactBreadcrumbs(paneName);
      }
      return;
    }

    if (!event.target.closest(".breadcrumb-strip")) {
      closeCompactBreadcrumbs();
    }

    const breadcrumbMenuButton = event.target.closest("[data-breadcrumb-menu-path]");
    if (breadcrumbMenuButton) {
      const paneName = breadcrumbMenuButton.dataset.breadcrumbMenuPane;
      if (isPaneName(paneName)) {
        event.preventDefault();
        app.activePane = paneName;
        await openBreadcrumbMenu(paneName, breadcrumbMenuButton.dataset.breadcrumbMenuPath, breadcrumbMenuButton);
      }
      return;
    }

    const breadcrumbChildOtherButton = event.target.closest("[data-breadcrumb-child-other-path]");
    if (breadcrumbChildOtherButton) {
      const paneName = breadcrumbChildOtherButton.dataset.breadcrumbChildOtherPane;
      if (isPaneName(paneName)) {
        const targetPane = otherPane(paneName);
        hideBreadcrumbMenu();
        await loadPane(targetPane, breadcrumbChildOtherButton.dataset.breadcrumbChildOtherPath);
        focusPaneList(targetPane);
      }
      return;
    }

    const breadcrumbChildButton = event.target.closest("[data-breadcrumb-child-path]");
    if (breadcrumbChildButton) {
      const paneName = breadcrumbChildButton.dataset.breadcrumbChildPane;
      if (isPaneName(paneName)) {
        hideBreadcrumbMenu();
        app.activePane = paneName;
        await loadPane(paneName, breadcrumbChildButton.dataset.breadcrumbChildPath);
        focusPaneList(paneName);
      }
      return;
    }

    const breadcrumbButton = event.target.closest("[data-breadcrumb-path]");
    if (breadcrumbButton) {
      const paneName = breadcrumbButton.dataset.breadcrumbPane;
      if (isPaneName(paneName)) {
        toggleCompactBreadcrumbs(paneName, false);
        app.activePane = paneName;
        await loadPane(paneName, breadcrumbButton.dataset.breadcrumbPath);
        focusPaneList(paneName);
      }
      return;
    }

    const navOpenOther = event.target.closest("[data-nav-open-other]");
    if (navOpenOther) {
      await loadPane(otherPane(app.activePane), navOpenOther.dataset.navOpenOther);
      return;
    }

    const shellOpenButton = event.target.closest("[data-shell-open]");
    if (shellOpenButton) {
      try {
        await openShellLocation(shellOpenButton.dataset.shellOpen);
      } catch (error) {
        showToast(error.message);
      }
      return;
    }

    const shellNamespaceOpenButton = event.target.closest("[data-shell-namespace-open]");
    if (shellNamespaceOpenButton) {
      await openShellNamespaceDialog(shellNamespaceOpenButton.dataset.shellNamespaceOpen || "thisPc");
      return;
    }

    const shellNamespaceRootButton = event.target.closest("[data-shell-namespace-root]");
    if (shellNamespaceRootButton) {
      try {
        await loadShellNamespace(shellNamespaceRootButton.dataset.shellNamespaceRoot || "thisPc", { push: true });
      } catch (error) {
        writeShellNamespaceError(error, "Shell namespace failed");
      }
      return;
    }

    if (event.target.closest("#shell-namespace-back")) {
      try {
        await goBackShellNamespace();
      } catch (error) {
        writeShellNamespaceError(error, "Shell namespace history failed");
      }
      return;
    }

    if (event.target.closest("#shell-namespace-refresh")) {
      try {
        await loadShellNamespace(app.shellNamespace?.target || "thisPc", { push: false });
      } catch (error) {
        writeShellNamespaceError(error, "Shell namespace refresh failed");
      }
      return;
    }

    const shellNamespaceBrowseButton = event.target.closest("[data-shell-namespace-browse-index]");
    if (shellNamespaceBrowseButton) {
      try {
        await browseShellNamespaceIndex(shellNamespaceBrowseButton.dataset.shellNamespaceBrowseIndex);
      } catch (error) {
        writeShellNamespaceError(error, "Shell namespace browse failed");
      }
      return;
    }

    const shellNamespacePaneButton = event.target.closest("[data-shell-namespace-pane-index]");
    if (shellNamespacePaneButton) {
      try {
        await openShellNamespaceIndexInPane(shellNamespacePaneButton.dataset.shellNamespacePaneIndex);
      } catch (error) {
        writeShellNamespaceError(error, "Shell namespace pane open failed");
      }
      return;
    }

    const shellNamespaceExternalButton = event.target.closest("[data-shell-namespace-external-index]");
    if (shellNamespaceExternalButton) {
      try {
        await openShellNamespaceIndexExternally(shellNamespaceExternalButton.dataset.shellNamespaceExternalIndex);
      } catch (error) {
        writeShellNamespaceError(error, "Shell namespace open failed");
      }
      return;
    }

    const treeToggle = event.target.closest("[data-tree-toggle]");
    if (treeToggle) {
      await toggleFolderTree(treeToggle.dataset.treeToggle);
      return;
    }

    const treeOpenOther = event.target.closest("[data-tree-open-other]");
    if (treeOpenOther) {
      await loadPane(otherPane(app.activePane), treeOpenOther.dataset.treeOpenOther);
      return;
    }

    const treeOpen = event.target.closest("[data-tree-open]");
    if (treeOpen) {
      await loadPane(app.activePane, treeOpen.dataset.treeOpen);
      return;
    }

    const removeFavoriteButton = event.target.closest("[data-remove-favorite]");
    if (removeFavoriteButton) {
      await removeFavorite(removeFavoriteButton.dataset.removeFavorite);
      return;
    }

    const navActionButton = event.target.closest("[data-nav-action]");
    if (navActionButton) {
      const action = navActionButton.dataset.navAction;
      if (action === "favorite-active") await addFavorite(app.activePane);
      if (action === "manage-favorites") await openFavoritesDialog();
      if (action === "clear-recents") await clearRecentLocations();
      if (action === "refresh-tree") await refreshFolderTree();
      if (action === "reveal-tree") await revealPathInFolderTree(tabOf(app.activePane).path);
      return;
    }

    const rootButton = event.target.closest("[data-root-path]");
    if (rootButton) {
      await loadPane(app.activePane, rootButton.dataset.rootPath);
      return;
    }

    const viewModeButton = event.target.closest("[data-view-mode]");
    if (viewModeButton) {
      app.activePane = viewModeButton.dataset.pane;
      setViewMode(viewModeButton.dataset.pane, viewModeButton.dataset.viewMode);
      return;
    }

    const quickSearchModeButton = event.target.closest("[data-quick-search-mode]");
    if (quickSearchModeButton) {
      setQuickSearchMode(quickSearchModeButton.dataset.pane, quickSearchModeButton.dataset.quickSearchMode);
      quickSearchInput(quickSearchModeButton.dataset.pane)?.focus();
      return;
    }

    const quickSearchStepButton = event.target.closest("[data-quick-search-step]");
    if (quickSearchStepButton) {
      focusQuickSearchMatch(
        quickSearchStepButton.dataset.pane,
        quickSearchStepButton.dataset.quickSearchStep === "previous" ? -1 : 1
      );
      quickSearchInput(quickSearchStepButton.dataset.pane)?.focus();
      return;
    }

    const quickSearchCloseButton = event.target.closest("[data-quick-search-close]");
    if (quickSearchCloseButton) {
      closeQuickSearch();
      return;
    }

    const favoriteSelectButton = event.target.closest("[data-select-favorite]");
    if (favoriteSelectButton) {
      app.activeFavoriteId = favoriteSelectButton.dataset.selectFavorite;
      renderFavoritesDialog();
      return;
    }

    const favoriteActionButton = event.target.closest("[data-favorite-action]");
    if (favoriteActionButton) {
      const action = favoriteActionButton.dataset.favoriteAction;
      try {
        if (action === "new") newFavorite();
        if (action === "add-active") await addActiveFavoriteFromManager();
        if (action === "open") await openActiveFavorite(false);
        if (action === "open-other") await openActiveFavorite(true);
        if (action === "up") await moveActiveFavorite(-1);
        if (action === "down") await moveActiveFavorite(1);
        if (action === "delete") await deleteActiveFavorite();
      } catch (error) {
        showToast(error.message);
      }
      return;
    }

    const historySwitchButton = event.target.closest("[data-history-switch]");
    if (historySwitchButton) {
      const paneName = historySwitchButton.dataset.historySwitch;
      if (isPaneName(paneName)) {
        app.historyDialog.paneName = paneName;
        app.activePane = paneName;
        updateActivePaneChrome();
        renderPaneHistoryDialog();
      }
      return;
    }

    const historyJumpButton = event.target.closest("[data-history-kind]");
    if (historyJumpButton) {
      const paneName = historyJumpButton.dataset.historyPane;
      await jumpToPaneHistory(paneName, historyJumpButton.dataset.historyKind, historyJumpButton.dataset.historyIndex);
      document.getElementById("history-dialog")?.close();
      focusPaneList(paneName);
      return;
    }

    const actionButton = event.target.closest("[data-action]");
    if (actionButton) {
      await handleAction(actionButton.dataset.action, actionButton.dataset.pane);
      return;
    }

    const row = event.target.closest("[data-entry-path]");
    if (row) {
      if (event.detail >= 2 && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        return;
      }
      if (
        event.detail === 1 &&
        singleClickOpenEnabled() &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        selectEntry(row.dataset.pane, row.dataset.entryPath, event);
        await openEntryFromGesture(row.dataset.pane, row.dataset.entryPath);
        return;
      }
      selectEntry(row.dataset.pane, row.dataset.entryPath, event);
      return;
    }

    const fileList = event.target.closest("[data-list]");
    if (fileList && isPaneName(fileList.dataset.list)) {
      app.activePane = fileList.dataset.list;
      updateActivePaneChrome();
      focusPaneList(fileList.dataset.list);
      renderInspector();
      return;
    }

    const tabButton = event.target.closest("[data-tab]");
    if (tabButton && !event.target.closest("[data-close-tab]")) {
      await activateTab(tabButton.dataset.pane, tabButton.dataset.tab);
      return;
    }

    const newTab = event.target.closest("[data-new-tab]");
    if (newTab) {
      duplicateTab(newTab.dataset.newTab);
      return;
    }

    const lockTab = event.target.closest("[data-lock-tab]");
    if (lockTab) {
      toggleTabLock(lockTab.dataset.pane, lockTab.dataset.lockTab);
      return;
    }

    const closeTabButton = event.target.closest("[data-close-tab]");
    if (closeTabButton) {
      closeTab(closeTabButton.dataset.pane, closeTabButton.dataset.closeTab);
      return;
    }

    const sortButton = event.target.closest("[data-sort]");
    if (sortButton) {
      const paneName = sortButton.dataset.pane;
      await sortPaneByColumn(paneName, sortButton.dataset.sort);
      return;
    }

    const workspacePanelButton = event.target.closest("[data-panel-action]");
    if (workspacePanelButton) {
      await toggleWorkspacePanel(workspacePanelButton.dataset.panelAction);
      return;
    }

    const layoutModeButton = event.target.closest("[data-layout-mode]");
    if (layoutModeButton) {
      setPaneLayout(layoutModeButton.dataset.layoutMode);
      return;
    }

    const sizeAnalysisViewButton = event.target.closest("[data-size-analysis-view]");
    if (sizeAnalysisViewButton) {
      setSizeAnalysisViewMode(sizeAnalysisViewButton.dataset.sizeAnalysisView);
      return;
    }

    const sizeAnalysisButton = event.target.closest("[data-size-analysis-action]");
    if (sizeAnalysisButton) {
      const action = sizeAnalysisButton.dataset.sizeAnalysisAction;
      if (action === "active") {
        setSizeAnalysisPathToActive();
        return;
      }
      if (action === "scan") {
        await runSizeAnalysis();
        return;
      }
      if (action === "cancel") {
        cancelSizeAnalysis();
        return;
      }
    }

    const sizeAnalysisMapFocus = event.target.closest("[data-size-analysis-map-focus]");
    if (sizeAnalysisMapFocus) {
      focusSizeAnalysisTreemap(sizeAnalysisMapFocus.dataset.sizeAnalysisMapFocus || "");
      return;
    }

    const sizeAnalysisMapAction = event.target.closest("[data-size-analysis-map-action]");
    if (sizeAnalysisMapAction) {
      const action = sizeAnalysisMapAction.dataset.sizeAnalysisMapAction;
      if (action === "root") {
        focusSizeAnalysisTreemap("");
        return;
      }
      if (action === "up") {
        focusSizeAnalysisTreemapParent();
        return;
      }
      if (action === "focus") {
        focusSizeAnalysisTreemap(app.sizeAnalysis.treemapSelection?.path || "");
        return;
      }
      if (action === "open") {
        await openSizeAnalysisTreemapItem(app.sizeAnalysis.treemapSelection);
        return;
      }
    }

    const sizeAnalysisOpen = event.target.closest("[data-size-analysis-open]");
    if (sizeAnalysisOpen) {
      const itemPath = sizeAnalysisOpen.dataset.sizeAnalysisOpen;
      const parentPath = sizeAnalysisOpen.dataset.sizeAnalysisParent;
      const selectPath = sizeAnalysisOpen.dataset.sizeAnalysisSelect;
      if (parentPath && selectPath) {
        await loadPane(app.activePane, parentPath);
        if (selectPathInPane(app.activePane, selectPath)) {
          renderPane(app.activePane);
          scrollFocusedEntryIntoView(app.activePane);
          renderInspector();
          updateSelectionReadout();
        }
        return;
      }
      if (itemPath) {
        await loadPane(app.activePane, itemPath);
      }
      return;
    }

    const topbarButton = event.target.closest("[data-topbar-action]");
    if (topbarButton) {
      const action = topbarButton.dataset.topbarAction;
      if (action === "search") await deepSearch(app.activePane);
      if (action === "sizeAnalysis") openSizeAnalysisDialog(app.activePane, "map");
      if (action === "ops") await openOpsDialog();
      if (action === "palette") await openCommandDialog();
      if (action === "focus") await toggleFocusMode();
      return;
    }

    const globalButton = event.target.closest("[data-global-action]");
    if (globalButton) {
      const action = globalButton.dataset.globalAction;
      if (action === "palette") await openCommandDialog();
      if (action === "manual") await openManualDialog();
      if (action === "commands") await openToolsDialog();
      if (action === "hotkeys") await openHotkeysDialog();
      if (action === "backup") await openBackupDialog();
      if (action === "preferences") await openPreferencesDialog();
      if (action === "toolbar") await openToolbarDialog();
      if (action === "layouts") await openLayoutsDialog();
      if (action === "tabGroups") await openTabGroupsDialog();
      if (action === "aliases") openAliasesDialog();
      if (action === "collections") await openCollectionsDialog();
      if (action === "basketAdd") await addSelectionToBasket(app.activePane);
      if (action === "basket") await openBasketDialog();
      if (action === "snapshots") await openSnapshotsDialog();
      if (action === "labels") await openLabelsDialog(app.activePane);
      if (action === "filters") await openFilterPresetsDialog(app.activePane);
      if (action === "columns") await openColumnsDialog(app.activePane);
      if (action === "formats") await openFormatsDialog(app.activePane);
      if (action === "presets") await openDisplayPresetsDialog(app.activePane);
      if (action === "selectMask") openSelectMaskDialog(app.activePane);
      if (action === "selectionSets") await openSelectionSetsDialog(app.activePane);
      if (action === "clipCut") await cutSelectionToClipboard(app.activePane);
      if (action === "clipCopy") await copySelectionToClipboard(app.activePane);
      if (action === "copyNames") openCopyNamesDialog(app.activePane);
      if (action === "checksums") openChecksumsDialog(app.activePane);
      if (action === "clipPaste") await pasteFileClipboard(app.activePane);
      if (action === "clipClear") await clearFileClipboard();
      if (action === "newFile") openNewFileDialog(app.activePane);
      if (action === "shortcut") await createShortcutsForSelection(app.activePane);
      if (action === "link") openLinkDialog(app.activePane);
      if (action === "script") openScriptDialog();
      if (action === "flat") openFlatDialog();
      if (action === "quickSearch") openQuickSearch(app.activePane, "filter");
      if (action === "speed") await openSpeedDialog(app.activePane);
      if (action === "search") await deepSearch(app.activePane);
      if (action === "duplicates") openDuplicatesDialog();
      if (action === "editText") await openTextEditor(app.activePane);
      if (action === "viewer") await openViewer(app.activePane);
      if (action === "properties") openPropertiesDialog(app.activePane);
      if (action === "attributes") openAttributesDialog(app.activePane);
      if (action === "timestamps") openTimestampsDialog(app.activePane);
      if (action === "windowsProperties") await openWindowsProperties(app.activePane);
      if (action === "folderSizes") await calculateFolderSizes(app.activePane);
      if (action === "sizeAnalysis") openSizeAnalysisDialog(app.activePane, "overview");
      if (action === "archive") openArchiveDialog(app.activePane);
      if (action === "compare") await openCompareDialog();
      if (action === "destination") await openDestinationDialog(app.activePane);
      if (action === "transfer") openTransferDialog(app.activePane);
      if (action === "bulkRename") openBulkRenameDialog(app.activePane);
      if (action === "openWith") openOpenWithDialog(app.activePane);
      if (action === "reveal") await revealSelected();
      if (action === "favorite") await addFavorite(app.activePane);
      if (action === "recycle") await recycleSelected(app.activePane);
      if (action === "delete") await deleteSelectedPermanently(app.activePane);
      if (action === "appTrash") await openAppTrashDialog();
      if (action === "ops") await openOpsDialog();
      if (action === "integration") await openIntegrationDialog();
    }
  });

  document.body.addEventListener("dblclick", async (event) => {
    if (event.target.closest("[data-inline-rename]")) {
      return;
    }
    const row = event.target.closest("[data-entry-path]");
    if (row) {
      event.preventDefault();
      selectEntry(row.dataset.pane, row.dataset.entryPath, event);
      await openEntryFromGesture(row.dataset.pane, row.dataset.entryPath, { otherPane: event.altKey });
      return;
    }
    const searchResult = event.target.closest("[data-search-path]");
    if (searchResult) {
      await request("/api/open", {
        method: "POST",
        body: JSON.stringify({ path: searchResult.dataset.searchPath, reveal: true })
      });
    }
  });

  document.body.addEventListener("auxclick", async (event) => {
    if (event.button !== 1 || event.target.closest("[data-inline-rename]")) {
      return;
    }
    const row = event.target.closest("[data-entry-path]");
    if (!row || !isPaneName(row.dataset.pane)) {
      return;
    }
    const entry = entryForPath(row.dataset.pane, row.dataset.entryPath);
    if (!entry?.isDirectory) {
      return;
    }
    event.preventDefault();
    try {
      await openFolderInNewTab(row.dataset.pane, entry.path);
    } catch (error) {
      showToast(error.message);
    }
  });

  document.body.addEventListener("input", (event) => {
    const inlineRenameInput = event.target.closest("[data-inline-rename]");
    if (inlineRenameInput && app.inlineRename) {
      app.inlineRename.value = inlineRenameInput.value;
      return;
    }
    const pathInput = event.target.closest("[data-path-input]");
    if (pathInput) {
      app.activePane = pathInput.dataset.pathInput;
      showPathSuggestions(pathInput.dataset.pathInput, pathInput.value);
      return;
    }
    const filter = event.target.closest("[data-filter]");
    if (filter) {
      tabOf(filter.dataset.filter).filter = filter.value;
      renderPane(filter.dataset.filter);
      scheduleStateSave();
    }
    const quickSearch = event.target.closest("[data-quick-search-input]");
    if (quickSearch) {
      applyQuickSearchQuery(quickSearch.dataset.quickSearchInput, quickSearch.value);
      return;
    }
    if (event.target.id === "manual-search") {
      app.manual.query = event.target.value;
      renderManualDialog();
      return;
    }
    if (event.target.id === "speed-query") {
      app.speed.search = null;
      app.speed.backgroundSearch = null;
      renderSpeedDialog();
      return;
    }
    if (event.target.id === "command-input") {
      app.commandPalette.activeIndex = 0;
      renderCommands(event.target.value);
    }
    if (event.target.id === "hotkey-combo") {
      updateHotkeyConflict();
    }
    if (event.target.id === "text-editor-content") {
      updateTextEditorSummary();
    }
    if (event.target.id === "new-file-name") {
      updateNewFileTemplate(false);
    }
    if (event.target.closest("#copy-names-dialog")) {
      renderCopyNamesDialog();
    }
    if (event.target.closest("#favorites-dialog")) {
      renderFavoritePreview();
    }
    if (event.target.closest("#destination-dialog")) {
      renderDestinationDialog();
    }
  });

  document.body.addEventListener("focusin", (event) => {
    const pathInput = event.target.closest("[data-path-input]");
    if (pathInput) {
      app.activePane = pathInput.dataset.pathInput;
      showPathSuggestions(pathInput.dataset.pathInput, pathInput.value);
    }
  });

  document.body.addEventListener("focusout", async (event) => {
    const pathInput = event.target.closest("[data-path-input]");
    if (pathInput) {
      setTimeout(() => {
        if (!document.activeElement?.closest?.("[data-path-input], [data-path-suggest]")) {
          hidePathSuggestions(pathInput.dataset.pathInput);
        }
      }, 120);
      return;
    }
    const inlineRenameInput = event.target.closest("[data-inline-rename]");
    if (!inlineRenameInput) {
      return;
    }
    if (
      app.inlineRename?.paneName === inlineRenameInput.dataset.inlineRenamePane &&
      samePath(app.inlineRename.path, inlineRenameInput.dataset.inlineRenamePath)
    ) {
      await commitInlineRename(inlineRenameInput);
    }
  });

  document.body.addEventListener("change", async (event) => {
    if (event.target.id === "size-analysis-size-by") {
      setSizeAnalysisMapEncoding({ sizeMode: event.target.value });
      return;
    }
    if (event.target.id === "size-analysis-color-by") {
      setSizeAnalysisMapEncoding({ colorMode: event.target.value });
      return;
    }
    if (event.target.closest("#copy-names-dialog")) {
      renderCopyNamesDialog();
    }
    if (event.target.closest("#favorites-dialog")) {
      renderFavoritePreview();
    }
    if (event.target.closest("#destination-dialog")) {
      renderDestinationDialog();
    }
    if (event.target.id === "new-file-template") {
      const template = event.target.value;
      const nameInput = document.getElementById("new-file-name");
      if (!nameInput.value || nameInput.value === "New File.txt" || nameInput.value === "notes.md" || nameInput.value === "data.json" || nameInput.value === "script.js" || nameInput.value === "script.ps1") {
        nameInput.value = defaultNewFileName(template);
      }
      updateNewFileTemplate(true);
    }
    if (event.target.id === "preference-startup-mode" || event.target.id === "preference-startup-layout") {
      const settings = preferenceSettingsDraftFromForm();
      renderStartupLayoutPicker(settings);
      document.getElementById("preference-startup-mode").value = settings.startupMode;
      renderPreferencesSummary(settings);
      return;
    }
    const labelFilter = event.target.closest("[data-label-filter]");
    if (labelFilter) {
      tabOf(labelFilter.dataset.labelFilter).labelFilter = labelFilter.value;
      renderPane(labelFilter.dataset.labelFilter);
      updateSelectionReadout();
      scheduleStateSave();
      return;
    }
    const kindFilter = event.target.closest("[data-kind-filter]");
    if (kindFilter) {
      setKindFilter(kindFilter.dataset.kindFilter, kindFilter.value);
      return;
    }
    const trashSelect = event.target.closest("[data-trash-select]");
    if (trashSelect) {
      if (trashSelect.checked) {
        app.trashBrowser.selected.add(trashSelect.dataset.trashSelect);
      } else {
        app.trashBrowser.selected.delete(trashSelect.dataset.trashSelect);
      }
      renderAppTrash();
      return;
    }
    const windowsRecycleSelect = event.target.closest("[data-windows-recycle-select]");
    if (windowsRecycleSelect) {
      if (windowsRecycleSelect.checked) {
        app.trashBrowser.windowsSelected.add(windowsRecycleSelect.dataset.windowsRecycleSelect);
      } else {
        app.trashBrowser.windowsSelected.delete(windowsRecycleSelect.dataset.windowsRecycleSelect);
      }
      renderTrashBrowser();
      return;
    }
    const recoverySelect = event.target.closest("[data-operation-recovery-select]");
    if (recoverySelect) {
      const index = Number(recoverySelect.dataset.operationRecoverySelect);
      if (Number.isInteger(index)) {
        if (recoverySelect.checked) {
          app.operationDetails.selectedRemaining.add(index);
        } else {
          app.operationDetails.selectedRemaining.delete(index);
        }
        renderOperationDetails();
      }
      return;
    }
    const backupSelect = event.target.closest("[data-operation-backup-select]");
    if (backupSelect) {
      const index = Number(backupSelect.dataset.operationBackupSelect);
      if (Number.isInteger(index)) {
        if (!app.operationDetails.selectedBackups) {
          app.operationDetails.selectedBackups = new Set();
        }
        if (backupSelect.checked) {
          app.operationDetails.selectedBackups.add(index);
        } else {
          app.operationDetails.selectedBackups.delete(index);
        }
        renderOperationDetails();
      }
      return;
    }
    const transferPolicySelect = event.target.closest("[data-transfer-policy]");
    if (transferPolicySelect) {
      try {
        const itemPath = transferPolicySelect.dataset.transferPolicy;
        const policy = transferPolicySelect.value;
        app.transfer.itemPolicies = app.transfer.itemPolicies || {};
        if (policy) {
          app.transfer.itemPolicies[itemPath] = policy;
        } else {
          delete app.transfer.itemPolicies[itemPath];
        }
        await runTransferPreview();
      } catch (error) {
        document.getElementById("transfer-summary").textContent = error.message;
        showToast(error.message);
      }
      return;
    }
    if (event.target.id === "launch-mode") {
      try {
        await updateIntegrationSetting("launchMode", event.target.value);
      } catch (error) {
        showToast(error.message);
      }
    }
    if (event.target.id === "shell-open-mode") {
      try {
        await updateIntegrationSetting("shellOpenMode", event.target.value);
      } catch (error) {
        showToast(error.message);
      }
    }
    if (event.target.id === "paste-conflict-mode") {
      try {
        await updatePasteConflictMode(event.target.value);
      } catch (error) {
        showToast(error.message);
      }
    }
    if (event.target.id === "auto-refresh-toggle") {
      try {
        await updateAutoRefreshSetting(event.target.checked);
      } catch (error) {
        showToast(error.message);
      }
    }
    if (event.target.id === "show-hidden-toggle") {
      try {
        await updateShowHiddenSetting(event.target.checked);
      } catch (error) {
        showToast(error.message);
      }
    }
    if (event.target.id === "linked-navigation-toggle") {
      try {
        await updateLinkedNavigationSetting(event.target.checked);
      } catch (error) {
        showToast(error.message);
      }
    }
    if (event.target.id === "hotkey-target") {
      updateHotkeyConflict();
    }
  });

  document.body.addEventListener("keydown", async (event) => {
    const inlineRenameInput = event.target.closest?.("[data-inline-rename]");
    if (inlineRenameInput) {
      if (event.key === "Enter") {
        event.preventDefault();
        await commitInlineRename(inlineRenameInput);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        cancelInlineRename({ status: "Rename canceled" });
        return;
      }
      return;
    }
    if (event.target.id === "hotkey-combo") {
      captureHotkeyInput(event);
      return;
    }
    if (event.target.id === "command-input" && await handleCommandPaletteKey(event)) {
      return;
    }
    if (event.target.id === "speed-query" && event.key === "Enter") {
      event.preventDefault();
      await searchSpeedIndex();
      return;
    }
    if (handleQuickSearchKey(event)) {
      return;
    }
    if (event.key === "Escape" && app.contextMenu) {
      event.preventDefault();
      hideContextMenu();
      return;
    }
    if (event.key === "Escape" && app.breadcrumbMenu?.path) {
      event.preventDefault();
      hideBreadcrumbMenu();
      return;
    }
    if (event.key === "Escape" && document.querySelector(".pane.compact-breadcrumbs-open")) {
      event.preventDefault();
      closeCompactBreadcrumbs();
      return;
    }
    if (await handleViewerKey(event)) {
      return;
    }
    const pathInput = event.target.closest("[data-path-input]");
    if (pathInput && await handlePathSuggestionKey(event, pathInput)) {
      return;
    }
    if (pathInput && event.key === "Enter") {
      event.preventDefault();
      hidePathSuggestions(pathInput.dataset.pathInput);
      app.activePane = pathInput.dataset.pathInput;
      try {
        await loadPane(pathInput.dataset.pathInput, pathInput.value);
        focusPaneList(pathInput.dataset.pathInput);
      } catch {
        pathInput.value = tabOf(pathInput.dataset.pathInput).path;
      }
      return;
    }
    if (await handleCustomHotkey(event)) {
      return;
    }
    if (event.key === "F9" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      await toggleFocusMode();
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      await openCommandDialog();
      return;
    }
    if (await handlePaneShortcut(event)) {
      return;
    }
  });

  document.body.addEventListener("click", async (event) => {
    const previewActionButton = event.target.closest("[data-preview-action]");
    if (previewActionButton) {
      try {
        const action = previewActionButton.dataset.previewAction;
        if (action === "viewer") {
          await openViewer(app.activePane, previewActionButton.dataset.previewPath);
        }
        if (action === "edit-text") {
          await openTextEditor(app.activePane, previewActionButton.dataset.previewPath);
        }
      } catch (error) {
        showToast(error.message);
      }
      return;
    }

    const viewerActionButton = event.target.closest("[data-viewer-action]");
    if (viewerActionButton) {
      try {
        const action = viewerActionButton.dataset.viewerAction;
        if (action === "previous") await stepViewer(-1);
        if (action === "next") await stepViewer(1);
        if (action === "reveal") await revealViewerPath();
      } catch (error) {
        showToast(error.message);
      }
      return;
    }

    const viewerPathButton = event.target.closest("[data-viewer-path]");
    if (viewerPathButton) {
      try {
        await loadViewerPath(viewerPathButton.dataset.viewerPath);
      } catch (error) {
        showToast(error.message);
      }
      return;
    }

    const shellVerbButton = event.target.closest("[data-shell-verb-id]");
    if (shellVerbButton) {
      try {
        await runShellVerb(shellVerbButton.dataset.shellVerbId, shellVerbButton.dataset.shellVerbName);
      } catch (error) {
        document.getElementById("shell-verbs-output").textContent = error.message;
        renderShellVerbsDialog("Shell verb failed");
        showToast(error.message);
      }
      return;
    }

    if (event.target.closest("#shell-verbs-refresh")) {
      try {
        await loadShellVerbs();
      } catch (error) {
        document.getElementById("shell-verbs-output").textContent = error.message;
        renderShellVerbsDialog("Refresh failed");
        showToast(error.message);
      }
      return;
    }

    if (event.target.closest("[data-open-with-shell-verbs]")) {
      try {
        const paneName = app.openWith?.paneName || app.activePane;
        const targetPath = app.openWith?.targets?.[0]?.path || null;
        await openShellVerbsDialog(paneName, targetPath);
      } catch (error) {
        document.getElementById("open-with-output").textContent = error.message;
        renderOpenWithDialog("Shell verbs failed");
        showToast(error.message);
      }
      return;
    }

    const openWithModeButton = event.target.closest("[data-open-with-mode]");
    if (openWithModeButton) {
      try {
        await runOpenWith(openWithModeButton.dataset.openWithMode);
      } catch (error) {
        document.getElementById("open-with-output").textContent = error.message;
        renderOpenWithDialog("Launch failed");
        showToast(error.message);
      }
      return;
    }

    const openWithPresetButton = event.target.closest("[data-open-with-preset]");
    if (openWithPresetButton) {
      applyOpenWithPreset(openWithPresetButton.dataset.openWithPreset);
      return;
    }

    const openWithMatchedButton = event.target.closest("[data-open-with-matched-preset]");
    if (openWithMatchedButton) {
      try {
        app.activeOpenWithPresetId = openWithMatchedButton.dataset.openWithMatchedPreset;
        renderOpenWithPresets();
        await runActiveOpenWithPreset();
      } catch (error) {
        document.getElementById("open-with-output").textContent = error.message;
        renderOpenWithDialog("Launch failed");
        showToast(error.message);
      }
      return;
    }

    const openWithPresetActionButton = event.target.closest("[data-open-with-preset-action]");
    if (openWithPresetActionButton) {
      try {
        const action = openWithPresetActionButton.dataset.openWithPresetAction;
        if (action === "save") await saveOpenWithPresetFromForm(false);
        if (action === "replace") await saveOpenWithPresetFromForm(true);
        if (action === "apply") applyActiveOpenWithPreset();
        if (action === "run") await runActiveOpenWithPreset();
        if (action === "delete") await deleteActiveOpenWithPreset();
      } catch (error) {
        document.getElementById("open-with-output").textContent = error.message;
        renderOpenWithDialog("Preset action failed");
        showToast(error.message);
      }
      return;
    }

    const openWithActionButton = event.target.closest("[data-open-with-action]");
    if (openWithActionButton) {
      if (openWithActionButton.dataset.openWithAction === "use-folder") {
        document.getElementById("open-with-cwd").value = defaultOpenWithCwd();
      }
      return;
    }

    const copyNamesPresetButton = event.target.closest("[data-copy-names-preset]");
    if (copyNamesPresetButton) {
      applyCopyNamesPreset(copyNamesPresetButton.dataset.copyNamesPreset);
      return;
    }

    const copyNamesActionButton = event.target.closest("[data-copy-names-action]");
    if (copyNamesActionButton) {
      try {
        if (copyNamesActionButton.dataset.copyNamesAction === "copy") {
          await copyNamesToWindowsClipboard();
        }
      } catch (error) {
        renderCopyNamesDialog("Copy failed");
        showToast(error.message);
      }
      return;
    }

    const checksumsActionButton = event.target.closest("[data-checksums-action]");
    if (checksumsActionButton) {
      try {
        const action = checksumsActionButton.dataset.checksumsAction;
        if (action === "verify") await verifyChecksumManifest();
        if (action === "copy") await copyChecksumManifest();
        if (action === "download") await downloadChecksumManifest();
      } catch (error) {
        renderChecksumsDialog("Checksum action failed");
        showToast(error.message);
      }
      return;
    }

    const selectPresetActionButton = event.target.closest("[data-select-preset-action]");
    if (selectPresetActionButton) {
      try {
        const action = selectPresetActionButton.dataset.selectPresetAction;
        if (action === "save") await saveSelectPresetFromForm(false);
        if (action === "replace") await saveSelectPresetFromForm(true);
        if (action === "apply") applyActiveSelectPreset(true);
        if (action === "delete") await deleteActiveSelectPreset();
      } catch (error) {
        showToast(error.message);
      }
      return;
    }

    const selectionSetButton = event.target.closest("[data-select-selection-set]");
    if (selectionSetButton) {
      app.activeSelectionSetId = selectionSetButton.dataset.selectSelectionSet;
      renderSelectionSetsDialog();
      return;
    }

    const selectionSetActionButton = event.target.closest("[data-selection-set-action]");
    if (selectionSetActionButton) {
      try {
        const action = selectionSetActionButton.dataset.selectionSetAction;
        if (action === "new") newSelectionSetDraft();
        if (action === "replace") await saveSelectionSetFromCurrent(true);
        if (action === "apply") await applySelectionSet(false);
        if (action === "open") await applySelectionSet(true);
        if (action === "delete") await deleteActiveSelectionSet();
      } catch (error) {
        document.getElementById("selection-set-summary").textContent = error.message;
        showToast(error.message);
      }
      return;
    }

    const textEditorActionButton = event.target.closest("[data-text-editor-action]");
    if (textEditorActionButton) {
      try {
        const action = textEditorActionButton.dataset.textEditorAction;
        if (action === "reload") await reloadTextEditor();
        if (action === "reveal" && app.textEditor?.path) {
          await request("/api/open", {
            method: "POST",
            body: JSON.stringify({ path: app.textEditor.path, reveal: true })
          });
        }
      } catch (error) {
        updateTextEditorSummary(error.message);
        showToast(error.message);
      }
      return;
    }

    const newFileActionButton = event.target.closest("[data-new-file-action]");
    if (newFileActionButton) {
      if (newFileActionButton.dataset.newFileAction === "refresh-template") {
        updateNewFileTemplate(true);
      }
      return;
    }

    const commandViewButton = event.target.closest("[data-command-view]");
    if (commandViewButton) {
      app.commandPalette.view = commandViewButton.dataset.commandView;
      app.commandPalette.activeIndex = 0;
      updateCommandCenterViewButtons();
      renderCommands(document.getElementById("command-input")?.value || "");
      document.getElementById("command-input")?.focus();
      return;
    }

    const commandPinButton = event.target.closest("[data-command-pin]");
    if (commandPinButton) {
      toggleCommandPalettePin(commandPinButton.dataset.commandPin);
      document.getElementById("command-input")?.focus();
      return;
    }

    const commandItem = event.target.closest("[data-palette-index]");
    if (commandItem) {
      try {
        await runCommandPaletteItem(Number(commandItem.dataset.paletteIndex));
      } catch (error) {
        showToast(error.message);
      }
      return;
    }

    const searchResult = event.target.closest("[data-search-path]");
    if (searchResult) {
      const tab = tabOf(app.activePane);
      tab.selected = new Set([searchResult.dataset.searchPath]);
      tab.focusedPath = searchResult.dataset.searchPath;
      tab.anchorPath = searchResult.dataset.searchPath;
      renderAll();
      renderInspector();
    }

    const searchActionButton = event.target.closest("[data-search-action]");
    if (searchActionButton) {
      const action = searchActionButton.dataset.searchAction;
      document.getElementById("search-root").value =
        action === "other-root" ? tabOf(otherPane(app.activePane)).path : tabOf(app.activePane).path;
    }

    const searchPresetActionButton = event.target.closest("[data-search-preset-action]");
    if (searchPresetActionButton) {
      try {
        const action = searchPresetActionButton.dataset.searchPresetAction;
        if (action === "save") await saveSearchPresetFromForm(false);
        if (action === "replace") await saveSearchPresetFromForm(true);
        if (action === "apply") applyActiveSearchPreset();
        if (action === "delete") await deleteActiveSearchPreset();
      } catch (error) {
        document.getElementById("search-summary").textContent = error.message;
        showToast(error.message);
      }
    }

    const flatActionButton = event.target.closest("[data-flat-action]");
    if (flatActionButton) {
      const action = flatActionButton.dataset.flatAction;
      document.getElementById("flat-root").value =
        action === "other-root" ? tabOf(otherPane(app.activePane)).path : tabOf(app.activePane).path;
    }

    const duplicateActionButton = event.target.closest("[data-duplicate-action]");
    if (duplicateActionButton) {
      try {
        const action = duplicateActionButton.dataset.duplicateAction;
        if (action === "active-root" || action === "other-root") {
          document.getElementById("duplicates-root").value =
            action === "other-root" ? tabOf(otherPane(app.activePane)).path : tabOf(app.activePane).path;
        }
        if (action === "open-results") {
          if (!app.duplicateResult) {
            showToast("Run a duplicate scan first");
            return;
          }
          openDuplicateResultsInPane(app.duplicateResult, app.activePane);
        }
      } catch (error) {
        document.getElementById("duplicates-summary").textContent = error.message;
        showToast(error.message);
      }
    }

    const compareActionButton = event.target.closest("[data-compare-action]");
    if (compareActionButton) {
      try {
        const action = compareActionButton.dataset.compareAction;
        if (action === "swap") {
          const left = document.getElementById("compare-left");
          const right = document.getElementById("compare-right");
          const oldLeft = left.value;
          left.value = right.value;
          right.value = oldLeft;
          invalidateCompareResult("Folders swapped");
        }
        if (action === "previewLeftToRight") await previewSyncCompare("leftToRight");
        if (action === "previewRightToLeft") await previewSyncCompare("rightToLeft");
        if (action === "applySync") await applySyncPreview();
      } catch (error) {
        document.getElementById("compare-summary").textContent = error.message;
        showToast(error.message);
      }
    }

    const syncProfileActionButton = event.target.closest("[data-sync-profile-action]");
    if (syncProfileActionButton) {
      try {
        const action = syncProfileActionButton.dataset.syncProfileAction;
        if (action === "save") await saveSyncProfileFromForm(false);
        if (action === "replace") await saveSyncProfileFromForm(true);
        if (action === "apply") applyActiveSyncProfile();
        if (action === "delete") await deleteActiveSyncProfile();
      } catch (error) {
        document.getElementById("compare-summary").textContent = error.message;
        showToast(error.message);
      }
    }

    const bulkPresetActionButton = event.target.closest("[data-bulk-preset-action]");
    if (bulkPresetActionButton) {
      try {
        const action = bulkPresetActionButton.dataset.bulkPresetAction;
        if (action === "save") await saveBulkRenamePresetFromForm(false);
        if (action === "replace") await saveBulkRenamePresetFromForm(true);
        if (action === "apply") await applyActiveBulkRenamePreset();
        if (action === "delete") await deleteActiveBulkRenamePreset();
      } catch (error) {
        document.getElementById("bulk-summary").textContent = error.message;
        showToast(error.message);
      }
    }

    const bulkActionButton = event.target.closest("[data-bulk-action]");
    if (bulkActionButton) {
      try {
        if (bulkActionButton.dataset.bulkAction === "apply") {
          await applyBulkRename();
        }
      } catch (error) {
        document.getElementById("bulk-summary").textContent = error.message;
        showToast(error.message);
      }
    }

    const destinationTargetButton = event.target.closest("[data-destination-target-index]");
    if (destinationTargetButton) {
      const index = Number(destinationTargetButton.dataset.destinationTargetIndex);
      const target = app.destination?.targets?.[index];
      if (target?.path) {
        setDestinationTarget(target.path);
      }
      return;
    }

    const destinationActionButton = event.target.closest("[data-destination-action]");
    if (destinationActionButton) {
      try {
        const action = destinationActionButton.dataset.destinationAction;
        if (action === "preview") {
          previewDestinationInTransfer();
        }
        if (action === "other") {
          setDestinationTarget(tabOf(otherPane(app.destination?.paneName || app.activePane)).path);
        }
      } catch (error) {
        document.getElementById("destination-summary").textContent = error.message;
        showToast(error.message);
      }
      return;
    }

    const transferActionButton = event.target.closest("[data-transfer-action]");
    if (transferActionButton) {
      try {
        const action = transferActionButton.dataset.transferAction;
        if (action === "apply") {
          await applyTransfer();
        }
        if (action === "other") {
          document.getElementById("transfer-target").value = tabOf(otherPane(app.transfer?.paneName || app.activePane)).path;
          await runTransferPreview();
        }
      } catch (error) {
        document.getElementById("transfer-summary").textContent = error.message;
        showToast(error.message);
      }
    }

    const archiveTargetButton = event.target.closest("[data-archive-target]");
    if (archiveTargetButton) {
      const action = archiveTargetButton.dataset.archiveTarget;
      const targetPane = action.startsWith("active") ? app.activePane : otherPane(app.activePane);
      if (action.endsWith("create")) {
        document.getElementById("archive-target").value = tabOf(targetPane).path;
      } else {
        document.getElementById("archive-extract-target").value = tabOf(targetPane).path;
      }
    }

    const runToolButton = event.target.closest("[data-run-tool]");
    if (runToolButton) {
      try {
        await runTool(runToolButton.dataset.runTool);
      } catch (error) {
        showToast(error.message);
      }
    }

    const runScriptButton = event.target.closest("[data-run-script]");
    if (runScriptButton) {
      try {
        await runSavedScript(runScriptButton.dataset.runScript);
      } catch (error) {
        const output = document.getElementById("script-dialog")?.open
          ? document.getElementById("script-output")
          : null;
        if (output) {
          output.textContent = error.message;
        }
        showToast(error.message);
      }
    }

    const selectToolButton = event.target.closest("[data-select-tool]");
    if (selectToolButton) {
      app.activeToolId = selectToolButton.dataset.selectTool;
      renderToolManager();
    }

    const selectHotkeyButton = event.target.closest("[data-select-hotkey]");
    if (selectHotkeyButton) {
      app.activeHotkeyId = selectHotkeyButton.dataset.selectHotkey;
      renderHotkeys();
    }

    const selectScriptButton = event.target.closest("[data-select-script]");
    if (selectScriptButton) {
      app.activeScriptId = selectScriptButton.dataset.selectScript;
      renderScriptLibrary();
    }

    const selectCollectionButton = event.target.closest("[data-select-collection]");
    if (selectCollectionButton) {
      app.activeCollectionId = selectCollectionButton.dataset.selectCollection;
      renderCollections();
    }

    const selectSnapshotButton = event.target.closest("[data-select-snapshot]");
    if (selectSnapshotButton) {
      app.activePaneSnapshotId = selectSnapshotButton.dataset.selectSnapshot;
      renderPaneSnapshots();
    }

    const selectAliasButton = event.target.closest("[data-select-alias]");
    if (selectAliasButton) {
      app.activeAliasId = selectAliasButton.dataset.selectAlias;
      renderAliasesDialog();
    }

    const aliasActionButton = event.target.closest("[data-alias-action]");
    if (aliasActionButton) {
      try {
        const action = aliasActionButton.dataset.aliasAction;
        if (action === "new") newAlias();
        if (action === "active") useActivePathForAlias();
        if (action === "open") await openActiveAlias();
        if (action === "delete") await deleteActiveAlias();
      } catch (error) {
        document.getElementById("alias-summary").textContent = error.message;
        showToast(error.message);
      }
    }

    const collectionActionButton = event.target.closest("[data-collection-action]");
    if (collectionActionButton) {
      try {
        const action = collectionActionButton.dataset.collectionAction;
        if (action === "new") newCollection();
        if (action === "add") await addSelectionToCollection();
        if (action === "open") await openCollectionInPane();
        if (action === "delete") await deleteActiveCollection();
      } catch (error) {
        showToast(error.message);
      }
    }

    const snapshotActionButton = event.target.closest("[data-snapshot-action]");
    if (snapshotActionButton) {
      try {
        const action = snapshotActionButton.dataset.snapshotAction;
        if (action === "new") newPaneSnapshot();
        if (action === "capture") await savePaneSnapshotFromForm();
        if (action === "open") await openSnapshotInPane();
        if (action === "delete") await deleteActiveSnapshot();
      } catch (error) {
        document.getElementById("snapshot-summary").textContent = error.message;
        showToast(error.message);
      }
    }

    const collectionRemoveButton = event.target.closest("[data-collection-remove]");
    if (collectionRemoveButton) {
      try {
        await removeFromActiveCollection(collectionRemoveButton.dataset.collectionRemove);
      } catch (error) {
        showToast(error.message);
      }
    }

    const basketSelect = event.target.closest("[data-basket-select]");
    if (basketSelect) {
      const itemPath = basketSelect.dataset.basketSelect;
      if (basketSelect.checked) {
        app.fileBasket.selected.add(itemPath);
      } else {
        app.fileBasket.selected.delete(itemPath);
      }
      renderBasket();
    }

    const basketRemoveButton = event.target.closest("[data-basket-remove]");
    if (basketRemoveButton) {
      try {
        await removeBasketPaths([basketRemoveButton.dataset.basketRemove]);
        showToast("Basket item removed");
      } catch (error) {
        showToast(error.message);
      }
    }

    const basketActionButton = event.target.closest("[data-basket-action]");
    if (basketActionButton) {
      try {
        const action = basketActionButton.dataset.basketAction;
        if (action === "add") await addSelectionToBasket(app.activePane);
        if (action === "open") await openBasketInPane(app.activePane);
        if (action === "copy") await copyBasketHere();
        if (action === "move") await moveBasketHere();
        if (action === "archive") archiveBasketItems();
        if (action === "remove") await removeSelectedBasketItems();
        if (action === "clear") await clearFileBasket();
      } catch (error) {
        showToast(error.message);
      }
    }

    const labelActionButton = event.target.closest("[data-label-action]");
    if (labelActionButton) {
      try {
        if (labelActionButton.dataset.labelAction === "clear") {
          await clearLabelsFromSelection();
        }
      } catch (error) {
        showToast(error.message);
      }
    }

    const labelShowButton = event.target.closest("[data-label-show]");
    if (labelShowButton) {
      try {
        await showLabeledPath(labelShowButton.dataset.labelShow);
      } catch (error) {
        showToast(error.message);
      }
    }

    const columnActionButton = event.target.closest("[data-column-action]");
    if (columnActionButton) {
      try {
        if (columnActionButton.dataset.columnAction === "default") {
          await resetColumnsToDefault(app.activePane);
        }
        if (columnActionButton.dataset.columnAction === "all") {
          await applyColumnsFromDialog(detailColumnDefs.map((column) => column.id));
        }
        if (columnActionButton.dataset.columnAction === "autosize") {
          autosizeAllColumns(app.activePane);
        }
        if (columnActionButton.dataset.columnAction === "reset-widths") {
          resetColumnWidths(app.activePane);
        }
      } catch (error) {
        showToast(error.message);
      }
    }

    const columnPresetButton = event.target.closest("[data-column-preset]");
    if (columnPresetButton) {
      try {
        await applyColumnPreset(app.activePane, columnPresetButton.dataset.columnPreset);
      } catch (error) {
        showToast(error.message);
      }
    }

    const selectFormatButton = event.target.closest("[data-select-format]");
    if (selectFormatButton) {
      app.activeFolderFormatId = selectFormatButton.dataset.selectFormat;
      renderFolderFormats();
    }

    const formatActionButton = event.target.closest("[data-format-action]");
    if (formatActionButton) {
      try {
        const action = formatActionButton.dataset.formatAction;
        if (action === "new") newFolderFormat();
        if (action === "save") await saveFolderFormatFromForm();
        if (action === "apply") await applyActiveFolderFormat();
        if (action === "delete") await deleteActiveFolderFormat();
      } catch (error) {
        showToast(error.message);
      }
    }

    const selectDisplayPresetButton = event.target.closest("[data-select-display-preset]");
    if (selectDisplayPresetButton) {
      app.activeDisplayPresetId = selectDisplayPresetButton.dataset.selectDisplayPreset;
      renderDisplayPresets();
    }

    const selectFilterPresetButton = event.target.closest("[data-select-filter-preset]");
    if (selectFilterPresetButton) {
      app.activeFilterPresetId = selectFilterPresetButton.dataset.selectFilterPreset;
      renderFilterPresets();
    }

    const displayPresetActionButton = event.target.closest("[data-display-preset-action]");
    if (displayPresetActionButton) {
      try {
        const action = displayPresetActionButton.dataset.displayPresetAction;
        if (action === "new") newDisplayPreset();
        if (action === "apply") await applyActiveDisplayPreset();
        if (action === "delete") await deleteActiveDisplayPreset();
      } catch (error) {
        showToast(error.message);
      }
    }

    const filterPresetActionButton = event.target.closest("[data-filter-preset-action]");
    if (filterPresetActionButton) {
      try {
        const action = filterPresetActionButton.dataset.filterPresetAction;
        if (action === "new") newFilterPreset();
        if (action === "capture") captureFilterPresetFormFromPane();
        if (action === "apply") await applyActiveFilterPreset();
        if (action === "clear-pane") clearPaneFilters(app.activePane);
        if (action === "delete") await deleteActiveFilterPreset();
      } catch (error) {
        showToast(error.message);
      }
    }

    const tokenButton = event.target.closest("[data-insert-token]");
    if (tokenButton) {
      insertToolToken(tokenButton.dataset.insertToken);
    }

    const toolActionButton = event.target.closest("[data-tool-action]");
    if (toolActionButton) {
      try {
        const action = toolActionButton.dataset.toolAction;
        if (action === "new") newTool();
        if (action === "run") await runTool(null);
        if (action === "delete") await deleteActiveTool();
      } catch (error) {
        document.getElementById("tool-output").textContent = error.message;
      }
    }

    const hotkeyActionButton = event.target.closest("[data-hotkey-action]");
    if (hotkeyActionButton) {
      try {
        const action = hotkeyActionButton.dataset.hotkeyAction;
        if (action === "new") newHotkey();
        if (action === "clear") {
          document.getElementById("hotkey-combo").value = "";
          updateHotkeyConflict("Shortcut cleared.");
          document.getElementById("hotkey-combo").focus();
        }
        if (action === "run") await runHotkeyFromForm();
        if (action === "delete") await deleteActiveHotkey();
      } catch (error) {
        updateHotkeyConflict(error.message);
        showToast(error.message);
      }
    }

    const backupActionButton = event.target.closest("[data-backup-action]");
    if (backupActionButton) {
      try {
        const action = backupActionButton.dataset.backupAction;
        if (action === "export") exportConfigPackage();
        if (action === "import") openBackupPackageFilePicker();
      } catch (error) {
        renderBackupDialog(error.message);
        document.getElementById("backup-output").textContent = error.message;
        showToast(error.message);
      }
    }

    const preferencesActionButton = event.target.closest("[data-preferences-action]");
    if (preferencesActionButton) {
      try {
        const action = preferencesActionButton.dataset.preferencesAction;
        if (action === "reset") await resetPreferencesToDefaults();
        if (action === "integration") {
          document.getElementById("preferences-dialog").close();
          await openIntegrationDialog();
        }
      } catch (error) {
        document.getElementById("preferences-summary").textContent = error.message;
        showToast(error.message);
      }
    }

    const toolbarPresetButton = event.target.closest("[data-toolbar-preset]");
    if (toolbarPresetButton) {
      try {
        await applyToolbarPreset(toolbarPresetButton.dataset.toolbarPreset);
      } catch (error) {
        document.getElementById("toolbar-summary").textContent = error.message;
        showToast(error.message);
      }
    }

    const toolbarActionButton = event.target.closest("[data-toolbar-action]");
    if (toolbarActionButton) {
      try {
        const action = toolbarActionButton.dataset.toolbarAction;
        if (action === "all") await showAllToolbarActions();
        if (action === "essentials") await applyToolbarPreset("essentials");
      } catch (error) {
        document.getElementById("toolbar-summary").textContent = error.message;
        showToast(error.message);
      }
    }

    const scriptActionButton = event.target.closest("[data-script-action]");
    if (scriptActionButton) {
      try {
        const action = scriptActionButton.dataset.scriptAction;
        if (action === "new") newScript();
        if (action === "delete") await deleteActiveScript();
      } catch (error) {
        document.getElementById("script-output").textContent = error.message;
      }
    }

    const toolPackageButton = event.target.closest("[data-tool-package-action]");
    if (toolPackageButton) {
      try {
        const action = toolPackageButton.dataset.toolPackageAction;
        if (action === "export") exportToolPackage();
        if (action === "import") openToolPackageFilePicker();
      } catch (error) {
        updateToolPackageSummary(error.message);
        document.getElementById("tool-output").textContent = error.message;
      }
    }

    const scriptPackageButton = event.target.closest("[data-script-package-action]");
    if (scriptPackageButton) {
      try {
        const action = scriptPackageButton.dataset.scriptPackageAction;
        if (action === "export") exportScriptPackage();
        if (action === "import") openScriptPackageFilePicker();
      } catch (error) {
        updateScriptPackageSummary(error.message);
        document.getElementById("script-output").textContent = error.message;
      }
    }

    const undoButton = event.target.closest("[data-undo-operation]");
    if (undoButton) {
      try {
        await undoOperation(undoButton.dataset.undoOperation);
      } catch (error) {
        showToast(error.message);
      }
    }

    const retryButton = event.target.closest("[data-retry-operation]");
    if (retryButton) {
      try {
        await retryOperation(retryButton.dataset.retryOperation);
      } catch (error) {
        showToast(error.message);
        scheduleOperationPoll(200);
      }
    }

    const retryRemainingButton = event.target.closest("[data-retry-remaining-operation]");
    if (retryRemainingButton) {
      try {
        await retryRemainingOperation(retryRemainingButton.dataset.retryRemainingOperation);
      } catch (error) {
        showToast(error.message);
        scheduleOperationPoll(200);
      }
    }

    const elevatedRetryButton = event.target.closest("[data-elevated-retry-operation]");
    if (elevatedRetryButton) {
      try {
        await elevatedRetryOperation(elevatedRetryButton.dataset.elevatedRetryOperation);
      } catch (error) {
        showToast(error.message);
        scheduleOperationPoll(200);
      }
    }

    const operationDetailsButton = event.target.closest("[data-operation-details]");
    if (operationDetailsButton) {
      try {
        openOperationDetails(operationDetailsButton.dataset.operationDetails);
      } catch (error) {
        showToast(error.message);
      }
    }

    const operationDetailsActionButton = event.target.closest("[data-operation-details-action]");
    if (operationDetailsActionButton) {
      try {
        const action = operationDetailsActionButton.dataset.operationDetailsAction;
        const operationId = app.operationDetails?.id;
        if (action === "select-all") {
          setOperationDetailsSelection("all");
        }
        if (action === "select-none") {
          setOperationDetailsSelection("none");
        }
        if (action === "backup-select-all") {
          setOperationDetailsBackupSelection("all");
        }
        if (action === "backup-select-none") {
          setOperationDetailsBackupSelection("none");
        }
        if (action === "copy") {
          await copyOperationRecoveryReport(operationId);
        }
        if (action === "retry-remaining") {
          await retryRemainingOperation(operationId);
          renderOperationDetails();
        }
        if (action === "retry-selected") {
          await retrySelectedRemainingOperation(operationId, selectedOperationRecoveryIndexes());
        }
        if (action === "elevate-remaining") {
          await elevatedRetryOperation(operationId);
        }
        if (action === "elevate-selected") {
          await elevatedRetryOperation(operationId, selectedOperationRecoveryIndexes());
        }
        if (action === "backup-restore") {
          await recoverSelectedOperationBackups(operationId, "restore", selectedOperationBackupIndexes());
        }
        if (action === "backup-discard") {
          await recoverSelectedOperationBackups(operationId, "discard", selectedOperationBackupIndexes());
        }
      } catch (error) {
        showToast(error.message);
        scheduleOperationPoll(200);
      }
    }

    const copyOperationReportButton = event.target.closest("[data-copy-operation-report]");
    if (copyOperationReportButton) {
      try {
        await copyOperationRecoveryReport(copyOperationReportButton.dataset.copyOperationReport);
      } catch (error) {
        showToast(error.message);
      }
    }

    const cancelButton = event.target.closest("[data-cancel-operation]");
    if (cancelButton) {
      try {
        await cancelOperation(cancelButton.dataset.cancelOperation);
      } catch (error) {
        showToast(error.message);
      }
    }

    const pauseButton = event.target.closest("[data-pause-operation]");
    if (pauseButton) {
      try {
        await pauseOperation(pauseButton.dataset.pauseOperation);
      } catch (error) {
        showToast(error.message);
      }
    }

    const resumeButton = event.target.closest("[data-resume-operation]");
    if (resumeButton) {
      try {
        await resumeOperation(resumeButton.dataset.resumeOperation);
      } catch (error) {
        showToast(error.message);
      }
    }

    const trashActionButton = event.target.closest("[data-trash-action]");
    if (trashActionButton) {
      try {
        const action = trashActionButton.dataset.trashAction;
        if (action === "refresh") {
          if (app.trashBrowser.mode === "windows") await loadWindowsRecycleBin();
          else await loadAppTrash();
        }
        if (action === "restore") {
          if (app.trashBrowser.mode === "windows") await restoreSelectedWindowsRecycle();
          else await restoreSelectedTrash();
        }
        if (action === "delete") await deleteSelectedTrash();
        if (action === "open-windows") await openWindowsRecycleInExplorer();
      } catch (error) {
        showToast(error.message);
      }
    }

    const trashModeButton = event.target.closest("[data-trash-mode]");
    if (trashModeButton) {
      try {
        await switchTrashMode(trashModeButton.dataset.trashMode);
      } catch (error) {
        showToast(error.message);
      }
    }

    const integrationButton = event.target.closest("[data-integration-action]");
    if (integrationButton) {
      try {
        const action = integrationButton.dataset.integrationAction;
        if (action === "generate") {
          await generateIntegrationFiles();
        } else {
          await applyIntegration(action);
        }
      } catch (error) {
        document.getElementById("integration-output").textContent = error.message;
      }
    }

    const clearOpsButton = event.target.closest("[data-clear-operations]");
    if (clearOpsButton) {
      try {
        await clearOperations();
      } catch (error) {
        showToast(error.message);
      }
    }

    const layoutRestoreButton = event.target.closest("[data-layout-restore]");
    if (layoutRestoreButton) {
      try {
        await restoreSavedLayout(layoutRestoreButton.dataset.layoutRestore);
      } catch (error) {
        showToast(error.message);
      }
    }

    const layoutStartupButton = event.target.closest("[data-layout-startup]");
    if (layoutStartupButton) {
      try {
        await makeSavedLayoutStartup(layoutStartupButton.dataset.layoutStartup);
      } catch (error) {
        showToast(error.message);
      }
    }

    const layoutReplaceButton = event.target.closest("[data-layout-replace]");
    if (layoutReplaceButton) {
      try {
        await replaceSavedLayout(layoutReplaceButton.dataset.layoutReplace);
      } catch (error) {
        showToast(error.message);
      }
    }

    const layoutDeleteButton = event.target.closest("[data-layout-delete]");
    if (layoutDeleteButton) {
      try {
        await deleteSavedLayout(layoutDeleteButton.dataset.layoutDelete);
      } catch (error) {
        showToast(error.message);
      }
    }

    const layoutNewButton = event.target.closest("[data-layout-new]");
    if (layoutNewButton) {
      fillLayoutForm();
    }

    const tabGroupRestoreButton = event.target.closest("[data-tab-group-restore]");
    if (tabGroupRestoreButton) {
      try {
        await restoreSavedTabGroup(tabGroupRestoreButton.dataset.tabGroupRestore);
      } catch (error) {
        showToast(error.message);
      }
    }

    const tabGroupReplaceButton = event.target.closest("[data-tab-group-replace]");
    if (tabGroupReplaceButton) {
      try {
        await replaceSavedTabGroup(tabGroupReplaceButton.dataset.tabGroupReplace);
      } catch (error) {
        showToast(error.message);
      }
    }

    const tabGroupDeleteButton = event.target.closest("[data-tab-group-delete]");
    if (tabGroupDeleteButton) {
      try {
        await deleteSavedTabGroup(tabGroupDeleteButton.dataset.tabGroupDelete);
      } catch (error) {
        showToast(error.message);
      }
    }

    const tabGroupNewButton = event.target.closest("[data-tab-group-new]");
    if (tabGroupNewButton) {
      app.activeTabGroupId = null;
      fillTabGroupForm();
      renderTabGroups();
    }
  });

  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.closeDialog === "size-analysis-dialog" && app.sizeAnalysis.loading) {
        cancelSizeAnalysis("Scan canceled");
      }
      document.getElementById(button.dataset.closeDialog).close();
    });
  });

  const sizeAnalysisDialog = document.getElementById("size-analysis-dialog");
  if (sizeAnalysisDialog) {
    const cancelActiveSizeAnalysis = () => {
      if (app.sizeAnalysis.loading) {
        cancelSizeAnalysis("Scan canceled");
      }
    };
    sizeAnalysisDialog.addEventListener("cancel", cancelActiveSizeAnalysis);
    sizeAnalysisDialog.addEventListener("close", cancelActiveSizeAnalysis);
  }

  document.getElementById("tool-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveToolFromForm();
    } catch (error) {
      document.getElementById("tool-output").textContent = error.message;
    }
  });

  document.getElementById("hotkey-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveHotkeyFromForm();
    } catch (error) {
      updateHotkeyConflict(error.message);
      showToast(error.message);
    }
  });

  document.getElementById("backup-package-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    try {
      await importConfigPackageFile(file);
    } catch (error) {
      renderBackupDialog(error.message);
      document.getElementById("backup-output").textContent = error.message;
      showToast(error.message);
    } finally {
      event.target.value = "";
    }
  });

  document.getElementById("preferences-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await applyPreferencesFromForm();
    } catch (error) {
      document.getElementById("preferences-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("toolbar-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveToolbarFromDialog();
    } catch (error) {
      document.getElementById("toolbar-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("tool-package-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    try {
      await importToolPackageFile(file);
    } catch (error) {
      updateToolPackageSummary(error.message);
      document.getElementById("tool-output").textContent = error.message;
      showToast(error.message);
    } finally {
      event.target.value = "";
    }
  });

  document.getElementById("script-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveScriptFromForm();
    } catch (error) {
      document.getElementById("script-output").textContent = error.message;
    }
  });

  document.getElementById("script-package-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    try {
      await importScriptPackageFile(file);
    } catch (error) {
      updateScriptPackageSummary(error.message);
      document.getElementById("script-output").textContent = error.message;
      showToast(error.message);
    } finally {
      event.target.value = "";
    }
  });

  document.getElementById("select-form").addEventListener("submit", (event) => {
    event.preventDefault();
    applySelectMaskFromDialog();
  });

  document
    .querySelectorAll(
      [
        "#select-pattern",
        "#select-mode",
        "#select-scope",
        "#select-case",
        "#select-size-op",
        "#select-size-value",
        "#select-date-field",
        "#select-date-op",
        "#select-date-days",
        "#select-attribute"
      ].join(", ")
    )
    .forEach((element) => {
    element.addEventListener("input", updateSelectMaskPreview);
    element.addEventListener("change", updateSelectMaskPreview);
  });

  document.querySelector("[data-select-action='clear']").addEventListener("click", () => {
    document.getElementById("select-pattern").value = "";
    document.getElementById("select-mode").value = "replace";
    document.getElementById("select-scope").value = "all";
    document.getElementById("select-case").checked = false;
    document.getElementById("select-size-op").value = "any";
    document.getElementById("select-size-value").value = "";
    document.getElementById("select-date-field").value = "modified";
    document.getElementById("select-date-op").value = "any";
    document.getElementById("select-date-days").value = "";
    document.getElementById("select-attribute").value = "any";
    updateSelectMaskPreview();
  });

  document.getElementById("layout-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveCurrentLayoutFromForm();
    } catch (error) {
      document.getElementById("layout-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("tab-group-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveCurrentTabGroupFromForm();
    } catch (error) {
      document.getElementById("tab-group-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("alias-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveAliasFromForm();
    } catch (error) {
      document.getElementById("alias-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("favorite-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveFavoriteFromForm();
    } catch (error) {
      document.getElementById("favorite-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("collection-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveCollectionFromForm();
    } catch (error) {
      document.getElementById("collection-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("snapshot-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await savePaneSnapshotFromForm();
    } catch (error) {
      document.getElementById("snapshot-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("label-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await applyLabelFromForm();
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById("columns-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await applyColumnsFromDialog();
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById("format-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveFolderFormatFromForm();
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById("display-preset-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveDisplayPresetFromForm();
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById("filter-preset-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveFilterPresetFromForm();
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById("search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await runAdvancedSearch();
    } catch (error) {
      document.getElementById("search-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("search-preset-select").addEventListener("change", (event) => {
    app.activeSearchPresetId = event.target.value || null;
    renderSearchPresets();
  });

  document.getElementById("select-preset-select").addEventListener("change", (event) => {
    app.activeSelectPresetId = event.target.value || null;
    renderSelectPresets();
    applyActiveSelectPreset(false);
  });

  document.getElementById("selection-set-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveSelectionSetFromCurrent(false);
    } catch (error) {
      document.getElementById("selection-set-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("sync-profile-select").addEventListener("change", (event) => {
    app.activeSyncProfileId = event.target.value || null;
    renderSyncProfiles();
  });

  document.getElementById("bulk-preset-select").addEventListener("change", (event) => {
    app.activeBulkRenamePresetId = event.target.value || null;
    renderBulkRenamePresets();
  });

  document.getElementById("flat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await runFlatView();
    } catch (error) {
      document.getElementById("flat-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("duplicates-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await runDuplicateScan();
    } catch (error) {
      document.getElementById("duplicates-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("compare-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await runCompare();
    } catch (error) {
      document.getElementById("compare-summary").textContent = error.message;
      showToast(error.message);
    }
  });
  document.getElementById("compare-form").addEventListener("input", () => invalidateCompareResult("Ready"));
  document.getElementById("compare-form").addEventListener("change", () => invalidateCompareResult("Ready"));

  document.getElementById("bulk-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await runBulkRenamePreview();
    } catch (error) {
      document.getElementById("bulk-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("destination-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await applyDestinationTransfer();
    } catch (error) {
      document.getElementById("destination-summary").textContent = error.message;
      renderDestinationDialog(error.message);
      showToast(error.message);
    }
  });

  document.getElementById("transfer-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await runTransferPreview();
    } catch (error) {
      document.getElementById("transfer-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("archive-create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await createArchiveFromForm();
    } catch (error) {
      document.getElementById("archive-create-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("archive-extract-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await extractArchiveFromForm();
    } catch (error) {
      document.getElementById("archive-extract-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("checksums-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await runChecksumsReport();
    } catch (error) {
      renderChecksumsDialog(error.message);
      showToast(error.message);
    }
  });

  ["checksums-algorithm", "checksums-format", "checksums-max-hash"].forEach((id) => {
    const control = document.getElementById(id);
    control.addEventListener(id === "checksums-max-hash" ? "input" : "change", resetChecksumReportForOptions);
  });

  document.getElementById("properties-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await runPropertiesReport();
    } catch (error) {
      document.getElementById("properties-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("properties-diagnose").addEventListener("click", async () => {
    try {
      await runPathDiagnostics();
    } catch (error) {
      document.getElementById("properties-diagnostics").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("attributes-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await applyAttributesFromForm();
    } catch (error) {
      document.getElementById("attributes-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("timestamps-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await applyTimestampsFromForm();
    } catch (error) {
      document.getElementById("timestamps-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.querySelector("[data-timestamps-action='now']").addEventListener("click", () => {
    setTimestampInputsToNow();
    document.getElementById("timestamps-summary").textContent = "Ready";
  });

  document.getElementById("text-editor-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveTextEditor();
    } catch (error) {
      updateTextEditorSummary(error.message);
      showToast(error.message);
    }
  });

  document.getElementById("new-file-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await createNewFileFromForm();
    } catch (error) {
      document.getElementById("new-file-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("link-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await createLinksFromForm();
    } catch (error) {
      document.getElementById("link-summary").textContent = error.message;
      showToast(error.message);
    }
  });

  document.getElementById("open-with-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await runOpenWith("custom");
    } catch (error) {
      document.getElementById("open-with-output").textContent = error.message;
      renderOpenWithDialog("Launch failed");
      showToast(error.message);
    }
  });
  document.getElementById("open-with-preset-select").addEventListener("change", (event) => {
    app.activeOpenWithPresetId = event.target.value || null;
    renderOpenWithPresets();
    applyActiveOpenWithPreset();
  });

  document.getElementById("run-script").addEventListener("click", async () => {
    try {
      await runScript();
    } catch (error) {
      document.getElementById("script-output").textContent = error.message;
    }
  });

  document.getElementById("clear-script-output").addEventListener("click", () => {
    document.getElementById("script-output").textContent = "";
  });

  document.querySelectorAll(".pane").forEach((pane) => {
    pane.addEventListener("pointerdown", () => {
      const previousPane = app.activePane;
      app.activePane = pane.dataset.pane;
      if (previousPane !== app.activePane) {
        updateActivePaneChrome();
        renderRoots();
        scheduleStateSave();
      }
    });
  });
}

async function init() {
  const startupStartedAt = performance.now();
  wireEvents();
  setupDockOverflow();
  const urlParams = new URL(window.location.href).searchParams;
  const [roots, shellLocations] = await Promise.all([
    request("/api/roots"),
    request("/api/shell/locations"),
    loadState()
  ]);
  app.roots = roots;
  app.shellLocations = shellLocations;
  applyAppSettingsChrome();
  hydratePanesFromState(urlParams);
  const paneLoads = Promise.all([
    loadStartupPane("left", tabOf("left").path || app.roots.cwd, app.roots.cwd, {
      allowRecovery: !startupPaneHasExplicitTarget("left", urlParams)
    }),
    loadStartupPane("right", tabOf("right").path || app.roots.home, app.roots.home, {
      allowRecovery: !startupPaneHasExplicitTarget("right", urlParams)
    })
  ]);
  renderRoots();
  renderSavedCommandStrip();
  renderToolManager();
  renderHotkeys();
  renderBackupDialog();
  renderScriptLibrary();
  renderTabGroups();
  renderFavoritesDialog();
  renderAliasesDialog();
  renderBasket();
  renderPaneSnapshots();
  renderDisplayPresets();
  renderFilterPresets();
  renderSyncProfiles();
  renderOpenWithPresets();
  renderSelectPresets();
  renderSelectionSetsDialog();
  renderSearchPresets();
  renderBulkRenamePresets();
  const startupPaneResults = await paneLoads;
  if (startupPaneResults.some((result) => result?.recovered)) {
    scheduleStateSave();
  }
  renderOperations();
  renderPreferencesDialog();
  renderToolbarDialog();
  startOperationPolling();
  startAutoRefresh();
  renderShowHiddenToggle();
  renderLinkedNavigationToggle();
  setStatus("Ready");
  window.__exploreBetterStartup = {
    readyMs: Math.round((performance.now() - startupStartedAt) * 10) / 10,
    completedAt: Date.now()
  };
  loadIntegrationStatus()
    .then(() => renderIntegration())
    .catch((error) => console.warn(`Could not load integration status: ${error.message}`));
}

init().catch((error) => {
  setStatus("Startup error");
  showToast(error.message);
});
