package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestScanTreeTruncationIsExactFit(t *testing.T) {
	fixture := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if err := os.WriteFile(filepath.Join(fixture, name), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	out := &writer{encoder: json.NewEncoder(io.Discard)}
	for _, item := range []struct {
		maxEntries int
		truncated  bool
	}{{3, false}, {2, true}, {4, false}} {
		result, err := scanTree(context.Background(), request{ID: "scan", Path: fixture, MaxEntries: item.maxEntries}, out)
		if err != nil {
			t.Fatal(err)
		}
		if result["truncated"] != item.truncated {
			t.Errorf("maxEntries=%d: truncated = %v, want %v", item.maxEntries, result["truncated"], item.truncated)
		}
	}
}

func TestInputCloseCancelsActiveRequests(t *testing.T) {
	input, sender := io.Pipe()
	t.Cleanup(func() { input.Close(); sender.Close() })
	var output bytes.Buffer
	started := make(chan string, 2)
	canceled := make(chan string, 2)
	release := make(chan struct{})
	defer close(release)
	completed := make(chan error, 1)
	go func() {
		completed <- serveRequests(input, &writer{encoder: json.NewEncoder(&output)}, func(ctx context.Context, req request, _ *writer) (interface{}, error) {
			started <- req.ID
			select {
			case <-ctx.Done():
				canceled <- req.ID
				return nil, ctx.Err()
			case <-release:
				return nil, nil
			}
		})
	}()
	fixture := t.TempDir()
	for _, id := range []string{"first-owned-scan", "second-owned-scan"} {
		encoded, err := json.Marshal(request{Version: protocolVersion, ID: id, Op: "scan-tree", Path: fixture})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fmt.Fprintln(sender, string(encoded)); err != nil {
			t.Fatal(err)
		}
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("request did not start")
		}
	}
	if err := sender.Close(); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		select {
		case <-canceled:
		case <-time.After(time.Second):
			t.Fatal("closing the input pipe did not cancel an active request")
		}
	}
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("helper did not finish after canceled workers settled")
	}
	decoder := json.NewDecoder(&output)
	for range 2 {
		var result response
		if err := decoder.Decode(&result); err != nil {
			t.Fatal(err)
		}
		if result.OK || result.Error == nil || result.Error.Message != context.Canceled.Error() {
			t.Fatalf("expected a canceled response, got %#v", result)
		}
	}
}
