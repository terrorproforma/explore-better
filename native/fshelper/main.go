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
	Name        string `json:"name"`
	Path        string `json:"path"`
	Directory   bool   `json:"directory"`
	Logical     int64  `json:"logicalBytes"`
	Allocated   uint64 `json:"allocatedBytes"`
	Modified    int64  `json:"modifiedMs"`
	Allocation  string `json:"allocatedSource"`
	Accuracy    string `json:"allocationAccuracy"`
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
	items := make([]fileEntry, 0, min(maxEntries, 10000))
	var logical uint64
	var allocated uint64
	var files int
	var folders int
	var skipped int
	err := filepath.WalkDir(req.Path, func(itemPath string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			skipped++
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if itemPath == req.Path {
			return nil
		}
		if entry.IsDir() {
			folders++
			return nil
		}
		if files >= maxEntries {
			return filepath.SkipAll
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			skipped++
			return nil
		}
		value, source, accuracy, allocationErr := allocatedSize(itemPath, info.Size())
		if allocationErr != nil {
			value = uint64(max(info.Size(), 0))
			source = "logical-size-fallback"
			accuracy = "estimated"
			skipped++
		}
		items = append(items, fileEntry{Name: entry.Name(), Path: itemPath, Logical: info.Size(), Allocated: value, Modified: info.ModTime().UnixMilli(), Allocation: source, Accuracy: accuracy})
		files++
		logical += uint64(max(info.Size(), 0))
		allocated += value
		if files%1000 == 0 {
			out.send(response{Version: protocolVersion, ID: req.ID, Type: "progress", OK: true, Data: map[string]interface{}{"files": files, "folders": folders, "logicalBytes": logical, "allocatedBytes": allocated}})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	volume, volumeErr := volumeInfo(req.Path)
	if volumeErr != nil {
		volume = map[string]interface{}{"clusterSize": 0, "allocationAccuracy": "unknown", "error": volumeErr.Error()}
	}
	return map[string]interface{}{
		"path": req.Path, "entries": items, "files": files, "folders": folders, "skipped": skipped,
		"logicalBytes": logical, "allocatedBytes": allocated, "truncated": files >= maxEntries, "volume": volume,
	}, nil
}

func handle(ctx context.Context, req request, out *writer) (interface{}, error) {
	if req.Version != protocolVersion {
		return nil, fmt.Errorf("protocol version %d is not supported", req.Version)
	}
	switch req.Op {
	case "hello":
		return map[string]interface{}{"protocolVersion": protocolVersion, "platform": runtime.GOOS, "architecture": runtime.GOARCH}, nil
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
