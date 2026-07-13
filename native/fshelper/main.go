package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const protocolVersion = 1

type request struct {
	Version    int    `json:"version"`
	ID         string `json:"id"`
	Op         string `json:"op"`
	Path       string `json:"path,omitempty"`
	TargetID   string `json:"targetId,omitempty"`
	MaxEntries int    `json:"maxEntries,omitempty"`
	ShowHidden *bool  `json:"showHidden,omitempty"`
	Compact    bool   `json:"compact,omitempty"`
}

type browseEntry struct {
	Name       string `json:"n"`
	Attributes uint32 `json:"a"`
	Size       uint64 `json:"s,omitempty"`
	Modified   int64  `json:"m"`
	Created    int64  `json:"c"`
	Accessed   int64  `json:"x"`
}

type browseColumns struct {
	Format     string   `json:"format"`
	Names      []string `json:"n"`
	Attributes []uint32 `json:"a"`
	Sizes      []uint64 `json:"s"`
	Modified   []int64  `json:"m"`
	Created    []int64  `json:"c"`
	Accessed   []int64  `json:"x"`
}

func newBrowseColumns(capacity int) browseColumns {
	return browseColumns{
		Format:     "columns-v1",
		Names:      make([]string, 0, capacity),
		Attributes: make([]uint32, 0, capacity),
		Sizes:      make([]uint64, 0, capacity),
		Modified:   make([]int64, 0, capacity),
		Created:    make([]int64, 0, capacity),
		Accessed:   make([]int64, 0, capacity),
	}
}

func (columns *browseColumns) append(entry browseEntry) {
	columns.Names = append(columns.Names, entry.Name)
	columns.Attributes = append(columns.Attributes, entry.Attributes)
	columns.Sizes = append(columns.Sizes, entry.Size)
	columns.Modified = append(columns.Modified, entry.Modified)
	columns.Created = append(columns.Created, entry.Created)
	columns.Accessed = append(columns.Accessed, entry.Accessed)
}

func browseEntriesPayload(items []browseEntry, columns browseColumns, compact bool) interface{} {
	if compact {
		return columns
	}
	return items
}

type response struct {
	Version int         `json:"version"`
	ID      string      `json:"id"`
	Type    string      `json:"type"`
	OK      bool        `json:"ok"`
	Data    interface{} `json:"data,omitempty"`
	Error   *wireError  `json:"error,omitempty"`
}

type wireError struct {
	Message string `json:"message"`
	Code    string `json:"code,omitempty"`
	Path    string `json:"path,omitempty"`
}

type fileEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Directory  bool   `json:"directory"`
	Logical    int64  `json:"logicalBytes"`
	Allocated  uint64 `json:"allocatedBytes"`
	Modified   int64  `json:"modifiedMs"`
	Allocation string `json:"allocatedSource"`
	Accuracy   string `json:"allocationAccuracy"`
}

type treeScanMetadata struct {
	Items       []fileEntry
	FileIndexes []int
	Logical     uint64
	Files       int
	Folders     int
	Skipped     int
	Scanned     int
	Truncated   bool
}

type treeColumns struct {
	Format      string   `json:"format"`
	Root        string   `json:"root"`
	Paths       []string `json:"p"`
	Directories []int    `json:"d"`
	Logical     []int64  `json:"s"`
	Allocated   []uint64 `json:"a"`
	Modified    []int64  `json:"m"`
}

func compactTreeEntries(root string, items []fileEntry) treeColumns {
	cleanRoot := filepath.Clean(root)
	prefix := cleanRoot + string(os.PathSeparator)
	columns := treeColumns{
		Format:      "columns-v1",
		Root:        cleanRoot,
		Paths:       make([]string, 0, len(items)),
		Directories: make([]int, 0, len(items)),
		Logical:     make([]int64, 0, len(items)),
		Allocated:   make([]uint64, 0, len(items)),
		Modified:    make([]int64, 0, len(items)),
	}
	for _, item := range items {
		directory := 0
		if item.Directory {
			directory = 1
		}
		itemPath := item.Path
		if strings.HasPrefix(itemPath, prefix) {
			itemPath = itemPath[len(prefix):]
		}
		columns.Paths = append(columns.Paths, itemPath)
		columns.Directories = append(columns.Directories, directory)
		columns.Logical = append(columns.Logical, item.Logical)
		columns.Allocated = append(columns.Allocated, item.Allocated)
		columns.Modified = append(columns.Modified, item.Modified)
	}
	return columns
}

type writer struct {
	mu      sync.Mutex
	encoder *json.Encoder
}

func (w *writer) send(value response) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.encoder.Encode(value)
}

func errorResponse(req request, err error) response {
	wired := &wireError{Message: err.Error()}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		wired.Path = pathErr.Path
		wired.Code = fmt.Sprint(pathErr.Err)
	}
	return response{Version: protocolVersion, ID: req.ID, Type: "error", OK: false, Error: wired}
}

func enumerate(ctx context.Context, root string, maxEntries int) (map[string]interface{}, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	if maxEntries <= 0 || maxEntries > 500000 {
		maxEntries = 500000
	}
	items := make([]fileEntry, 0, min(len(entries), maxEntries))
	for _, entry := range entries {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		if len(items) >= maxEntries {
			break
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		item := fileEntry{Name: entry.Name(), Path: filepath.Join(root, entry.Name()), Directory: entry.IsDir(), Modified: info.ModTime().UnixMilli()}
		if !entry.IsDir() {
			item.Logical = info.Size()
			item.Allocated, item.Allocation, item.Accuracy, _ = allocatedSize(item.Path, info.Size())
		}
		items = append(items, item)
	}
	return map[string]interface{}{"path": root, "entries": items, "returned": len(items), "truncated": len(items) < len(entries)}, nil
}

func scanTree(ctx context.Context, req request, out *writer) (map[string]interface{}, error) {
	maxEntries := req.MaxEntries
	if maxEntries <= 0 || maxEntries > 500000 {
		maxEntries = 500000
	}
	metadataStarted := time.Now()
	metadata, err := collectTreeEntries(ctx, req.Path, maxEntries)
	if err != nil {
		return nil, err
	}
	metadataMs := float64(time.Since(metadataStarted).Microseconds()) / 1000
	items := metadata.Items
	fileIndexes := metadata.FileIndexes
	logical := metadata.Logical
	files := metadata.Files
	folders := metadata.Folders
	skipped := metadata.Skipped
	scanned := metadata.Scanned
	truncated := metadata.Truncated
	var allocated uint64

	allocationStarted := time.Now()
	workerCount := min(max(4, runtime.GOMAXPROCS(0)*4), 32)
	jobs := make(chan int, workerCount*4)
	var workers sync.WaitGroup
	var progressMu sync.Mutex
	processed := 0
	for worker := 0; worker < workerCount; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				item := &items[index]
				value, source, accuracy, allocationErr := allocatedSize(item.Path, item.Logical)
				failed := allocationErr != nil
				if failed {
					value = uint64(max(item.Logical, 0))
					source = "logical-size-fallback"
					accuracy = "estimated"
				}
				item.Allocated = value
				item.Allocation = source
				item.Accuracy = accuracy
				progressMu.Lock()
				allocated += value
				if failed {
					skipped++
				}
				processed++
				if processed%1000 == 0 {
					out.send(response{Version: protocolVersion, ID: req.ID, Type: "progress", OK: true, Data: map[string]interface{}{"files": processed, "folders": folders, "logicalBytes": logical, "allocatedBytes": allocated}})
				}
				progressMu.Unlock()
			}
		}()
	}
	for _, index := range fileIndexes {
		select {
		case <-ctx.Done():
			close(jobs)
			workers.Wait()
			return nil, ctx.Err()
		case jobs <- index:
		}
	}
	close(jobs)
	workers.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	allocationMs := float64(time.Since(allocationStarted).Microseconds()) / 1000
	volume, volumeErr := volumeInfo(req.Path)
	if volumeErr != nil {
		volume = map[string]interface{}{"clusterSize": 0, "allocationAccuracy": "unknown", "error": volumeErr.Error()}
	}
	entries := interface{}(items)
	wireFormat := "objects-v1"
	if req.Compact {
		entries = compactTreeEntries(req.Path, items)
		wireFormat = "columns-v1"
	}
	return map[string]interface{}{
		"path": req.Path, "entries": entries, "files": files, "folders": folders, "skipped": skipped,
		"logicalBytes": logical, "allocatedBytes": allocated, "scannedEntries": scanned,
		"truncated": truncated || scanned >= maxEntries, "entryLimitMode": "all-entries", "wireFormat": wireFormat, "volume": volume,
		"timing": map[string]interface{}{"enumerationMs": metadataMs, "allocationMs": allocationMs, "allocationWorkers": workerCount},
	}, nil
}

func handle(ctx context.Context, req request, out *writer) (interface{}, error) {
	if req.Version != protocolVersion {
		return nil, fmt.Errorf("protocol version %d is not supported", req.Version)
	}
	switch req.Op {
	case "hello":
		return map[string]interface{}{"protocolVersion": protocolVersion, "platform": runtime.GOOS, "architecture": runtime.GOARCH}, nil
	case "browse":
		return browseDirectory(ctx, req.Path, req.MaxEntries, req.ShowHidden, req.Compact)
	case "enumerate":
		return enumerate(ctx, req.Path, req.MaxEntries)
	case "volume-info":
		return volumeInfo(req.Path)
	case "allocated-size":
		info, err := os.Stat(req.Path)
		if err != nil {
			return nil, err
		}
		allocated, source, accuracy, err := allocatedSize(req.Path, info.Size())
		if err != nil {
			return nil, err
		}
		volume, _ := volumeInfo(req.Path)
		return map[string]interface{}{"path": req.Path, "logicalBytes": info.Size(), "allocatedBytes": allocated, "allocatedSource": source, "allocationAccuracy": accuracy, "volume": volume}, nil
	case "scan-tree":
		return scanTree(ctx, req, out)
	default:
		return nil, fmt.Errorf("operation %q is not supported", req.Op)
	}
}

func main() {
	out := &writer{encoder: json.NewEncoder(os.Stdout)}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	var controls sync.Map
	var workers sync.WaitGroup
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			out.send(errorResponse(request{ID: "unknown"}, err))
			continue
		}
		if req.Op == "cancel" {
			if value, ok := controls.Load(req.TargetID); ok {
				value.(context.CancelFunc)()
			}
			out.send(response{Version: protocolVersion, ID: req.ID, Type: "result", OK: true, Data: map[string]interface{}{"canceled": req.TargetID}})
			continue
		}
		ctx, cancel := context.WithCancel(context.Background())
		controls.Store(req.ID, cancel)
		workers.Add(1)
		go func(item request) {
			defer workers.Done()
			defer cancel()
			defer controls.Delete(item.ID)
			data, err := handle(ctx, item, out)
			if err != nil {
				out.send(errorResponse(item, err))
				return
			}
			out.send(response{Version: protocolVersion, ID: item.ID, Type: "result", OK: true, Data: data})
		}(req)
	}
	workers.Wait()
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	time.Sleep(time.Millisecond)
}
