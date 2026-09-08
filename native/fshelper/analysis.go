package main

import (
	"path/filepath"
	"sort"
	"strings"
)

const analysisTopFileLimit = 1200

type analysisFolder struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Parent    int    `json:"parent"`
	Depth     int    `json:"depth"`
	Logical   uint64 `json:"logicalBytes"`
	Allocated uint64 `json:"allocatedBytes"`
	Files     int    `json:"files"`
	Folders   int    `json:"folders"`
	Modified  int64  `json:"modifiedMs"`
}

type analysisFile struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Parent    string `json:"parent"`
	Extension string `json:"extension"`
	Logical   uint64 `json:"logicalBytes"`
	Allocated uint64 `json:"allocatedBytes"`
	Modified  int64  `json:"modifiedMs"`
}

type analysisExtension struct {
	Extension string `json:"extension"`
	Files     int    `json:"files"`
	Logical   uint64 `json:"logicalBytes"`
	Allocated uint64 `json:"allocatedBytes"`
}

type analysisAccumulator struct {
	Folders    []analysisFolder
	TopFiles   []analysisFile
	Extensions map[string]*analysisExtension
	Scanned    int
	Files      int
	Skipped    int
	Truncated  bool
}

func newAnalysisAccumulator(root string, modified int64) *analysisAccumulator {
	return &analysisAccumulator{
		Folders: []analysisFolder{{
			Name: filepath.Base(filepath.Clean(root)), Path: filepath.Clean(root), Parent: -1, Depth: 0, Modified: modified,
		}},
		TopFiles:   make([]analysisFile, 0, analysisTopFileLimit*2),
		Extensions: make(map[string]*analysisExtension),
	}
}

func (acc *analysisAccumulator) addFolder(name string, itemPath string, parent int, modified int64) int {
	depth := 0
	if parent >= 0 && parent < len(acc.Folders) {
		depth = acc.Folders[parent].Depth + 1
	}
	index := len(acc.Folders)
	acc.Folders = append(acc.Folders, analysisFolder{
		Name: name, Path: itemPath, Parent: parent, Depth: depth, Modified: modified,
	})
	for current := parent; current >= 0; current = acc.Folders[current].Parent {
		acc.Folders[current].Folders++
	}
	return index
}

func analysisExtensionFor(name string) string {
	extension := strings.ToLower(filepath.Ext(name))
	if extension == "" {
		return "(none)"
	}
	return extension
}

func (acc *analysisAccumulator) addFile(name string, itemPath string, parent int, logical uint64, allocated uint64, modified int64) {
	acc.Files++
	for current := parent; current >= 0; current = acc.Folders[current].Parent {
		acc.Folders[current].Files++
		acc.Folders[current].Logical += logical
		acc.Folders[current].Allocated += allocated
		if modified > acc.Folders[current].Modified {
			acc.Folders[current].Modified = modified
		}
	}
	extension := analysisExtensionFor(name)
	extensionRow := acc.Extensions[extension]
	if extensionRow == nil {
		extensionRow = &analysisExtension{Extension: extension}
		acc.Extensions[extension] = extensionRow
	}
	extensionRow.Files++
	extensionRow.Logical += logical
	extensionRow.Allocated += allocated
	parentPath := ""
	if parent >= 0 && parent < len(acc.Folders) {
		parentPath = acc.Folders[parent].Path
	}
	acc.TopFiles = append(acc.TopFiles, analysisFile{
		Name: name, Path: itemPath, Parent: parentPath, Extension: extension,
		Logical: logical, Allocated: allocated, Modified: modified,
	})
	if len(acc.TopFiles) > analysisTopFileLimit*2 {
		acc.trimTopFiles()
	}
}

func (acc *analysisAccumulator) trimTopFiles() {
	sort.Slice(acc.TopFiles, func(left int, right int) bool {
		return acc.TopFiles[left].Logical > acc.TopFiles[right].Logical
	})
	if len(acc.TopFiles) > analysisTopFileLimit {
		acc.TopFiles = acc.TopFiles[:analysisTopFileLimit]
	}
}

func (acc *analysisAccumulator) extensionRows() []analysisExtension {
	rows := make([]analysisExtension, 0, len(acc.Extensions))
	for _, row := range acc.Extensions {
		rows = append(rows, *row)
	}
	sort.Slice(rows, func(left int, right int) bool {
		return rows[left].Logical > rows[right].Logical
	})
	return rows
}

func (acc *analysisAccumulator) progressResult(root string, maxEntries int) map[string]interface{} {
	acc.trimTopFiles()
	folders := []analysisFolder{acc.Folders[0]}
	for _, folder := range acc.Folders[1:] {
		if folder.Parent == 0 {
			folder.Parent = 0
			folders = append(folders, folder)
		}
	}
	topFiles := acc.TopFiles
	if len(topFiles) > 200 {
		topFiles = topFiles[:200]
	}
	return map[string]interface{}{
		"path": root, "folderNodes": folders, "topFiles": topFiles, "extensions": acc.extensionRows(),
		"files": acc.Files, "folders": max(0, len(acc.Folders)-1), "skipped": acc.Skipped,
		"scannedEntries": acc.Scanned, "truncated": false, "maxEntries": maxEntries,
		"partial": true, "entryLimitMode": "summary-all-entries", "wireFormat": "summary-v1",
	}
}

func (acc *analysisAccumulator) result(root string, maxEntries int, volume map[string]interface{}, elapsedMs float64) map[string]interface{} {
	acc.trimTopFiles()
	return map[string]interface{}{
		"path": root, "folderNodes": acc.Folders, "topFiles": acc.TopFiles, "extensions": acc.extensionRows(),
		"files": acc.Files, "folders": max(0, len(acc.Folders)-1), "skipped": acc.Skipped,
		"scannedEntries": acc.Scanned, "truncated": acc.Truncated, "maxEntries": maxEntries,
		"entryLimitMode": "summary-all-entries", "wireFormat": "summary-v1", "volume": volume,
		"timing": map[string]interface{}{"totalMs": elapsedMs},
	}
}
