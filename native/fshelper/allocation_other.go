//go:build !windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func browseDirectory(ctx context.Context, root string, maxEntries int, showHidden *bool, compact bool) (map[string]interface{}, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	if maxEntries <= 0 || maxEntries > 500000 {
		maxEntries = 500000
	}
	items := make([]browseEntry, 0, min(len(entries), maxEntries))
	columns := newBrowseColumns(min(len(entries), maxEntries))
	total := 0
	hiddenFiltered := 0
	for _, entry := range entries {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		if showHidden != nil && !*showHidden && strings.HasPrefix(entry.Name(), ".") {
			hiddenFiltered++
			continue
		}
		total++
		if total > maxEntries {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		attributes := uint32(0)
		if entry.IsDir() {
			attributes = 0x10
		}
		modified := info.ModTime().UnixMilli()
		item := browseEntry{
			Name: entry.Name(), Attributes: attributes, Size: uint64(max(info.Size(), 0)),
			Modified: modified, Created: modified, Accessed: modified,
		}
		if compact {
			columns.append(item)
		} else {
			items = append(items, item)
		}
	}
	return map[string]interface{}{
		"path": root, "entries": browseEntriesPayload(items, columns, compact), "returned": min(total, maxEntries), "total": total,
		"hiddenFiltered": hiddenFiltered, "truncated": total > maxEntries,
	}, nil
}

func collectTreeEntries(ctx context.Context, root string, maxEntries int) (treeScanMetadata, error) {
	result := treeScanMetadata{
		Items:       make([]fileEntry, 0, min(maxEntries, 10000)),
		FileIndexes: make([]int, 0, min(maxEntries, 10000)),
	}
	err := filepath.WalkDir(root, func(itemPath string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			result.Skipped++
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if itemPath == root {
			return nil
		}
		if result.Scanned >= maxEntries {
			result.Truncated = true
			return filepath.SkipAll
		}
		if entry.Type()&os.ModeSymlink != 0 {
			result.Scanned++
			result.Skipped++
			return nil
		}
		if entry.IsDir() {
			result.Items = append(result.Items, fileEntry{Name: entry.Name(), Path: itemPath, Directory: true})
			result.Folders++
			result.Scanned++
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			result.Skipped++
			return nil
		}
		result.Items = append(result.Items, fileEntry{Name: entry.Name(), Path: itemPath, Logical: info.Size(), Modified: info.ModTime().UnixMilli()})
		result.FileIndexes = append(result.FileIndexes, len(result.Items)-1)
		result.Files++
		result.Scanned++
		result.Logical += uint64(max(info.Size(), 0))
		return nil
	})
	return result, err
}

func analyzeTree(ctx context.Context, req request, out *writer) (map[string]interface{}, error) {
	started := time.Now()
	root := filepath.Clean(req.Path)
	rootInfo, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	acc := newAnalysisAccumulator(root, rootInfo.ModTime().UnixMilli())
	foldersByPath := map[string]int{root: 0}
	err = filepath.WalkDir(root, func(itemPath string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			acc.Skipped++
			return nil
		}
		if itemPath == root {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if req.MaxEntries > 0 && acc.Scanned >= req.MaxEntries {
			acc.Truncated = true
			return filepath.SkipAll
		}
		acc.Scanned++
		if entry.Type()&os.ModeSymlink != 0 {
			acc.Skipped++
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			acc.Skipped++
			return nil
		}
		parent := foldersByPath[filepath.Dir(itemPath)]
		if entry.IsDir() {
			foldersByPath[itemPath] = acc.addFolder(entry.Name(), itemPath, parent, info.ModTime().UnixMilli())
			return nil
		}
		logical := uint64(max(info.Size(), 0))
		allocated, _, _, allocationErr := allocatedSize(itemPath, info.Size())
		if allocationErr != nil {
			allocated = logical
			acc.Skipped++
		}
		acc.addFile(entry.Name(), itemPath, parent, logical, allocated, info.ModTime().UnixMilli())
		if acc.Scanned == 1 || acc.Scanned%10000 == 0 {
			out.send(response{Version: protocolVersion, ID: req.ID, Type: "progress", OK: true, Data: acc.progressResult(root, req.MaxEntries)})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	volume, volumeErr := volumeInfo(root)
	if volumeErr != nil {
		volume = map[string]interface{}{"clusterSize": 0, "allocationAccuracy": "unknown", "error": volumeErr.Error()}
	}
	return acc.result(root, req.MaxEntries, volume, float64(time.Since(started).Microseconds())/1000), nil
}

func allocatedSize(_ string, logical int64) (uint64, string, string, error) {
	if logical < 0 {
		logical = 0
	}
	return uint64(logical), "logical-size-fallback", "estimated", nil
}

func volumeInfo(itemPath string) (map[string]interface{}, error) {
	return map[string]interface{}{"root": itemPath, "clusterSize": 0, "allocatedSource": "logical-size-fallback", "allocationAccuracy": "estimated"}, nil
}
