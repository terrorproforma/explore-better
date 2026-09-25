//go:build windows

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/Microsoft/go-winio"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestReadBridgeFramesRetainsBufferedUnicode(t *testing.T) {
	reader := bufio.NewReaderSize(strings.NewReader("{\"id\":\"hello\",\"type\":\"hello\"}\n{\"id\":\"unicode\",\"result\":{\"text\":\"café 😀 日本語\"}}\n"), 16)
	first, err := readBridgeFrame(reader)
	if err != nil || first.ID != "hello" {
		t.Fatalf("first frame: %+v, %v", first, err)
	}
	second, err := readBridgeFrame(reader)
	if err != nil || second.ID != "unicode" || !strings.Contains(string(second.Result), "café 😀 日本語") {
		t.Fatalf("second frame: %+v, %v", second, err)
	}
}

func TestReadBridgeFrameStopsAtByteLimit(t *testing.T) {
	reader := bufio.NewReaderSize(strings.NewReader(strings.Repeat("x", maxBridgeFrameBytes+1)), 4096)
	if _, err := readBridgeFrame(reader); err == nil || !strings.Contains(err.Error(), "frame limit") {
		t.Fatalf("expected a bounded frame error, got %v", err)
	}
}

type shortWriter struct{}

func (shortWriter) Write(data []byte) (int, error) { return len(data) - 1, nil }

func TestWriteBridgeFrameReportsShortWrite(t *testing.T) {
	if err := writeBridgeFrame(shortWriter{}, bridgeFrame{ID: "fixture"}); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("expected a short write error, got %v", err)
	}
}

func TestBridgeStartupWaitHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	if err := waitForBridge(ctx, time.Second); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	if time.Since(started) > 250*time.Millisecond {
		t.Fatal("canceled startup waited for the polling interval")
	}
}

func TestBridgeCloseSettlesPendingRequests(t *testing.T) {
	left, right := net.Pipe()
	defer right.Close()
	reply := make(chan bridgeFrame, 1)
	disconnected := make(chan struct{})
	bridge := &bridgeClient{conn: left, pending: map[string]chan bridgeFrame{"fixture": reply}, disconnected: disconnected}
	bridge.close()
	bridge.close()
	select {
	case frame := <-reply:
		if frame.Error == nil || frame.Error.Code != "BRIDGE_RESTARTING" {
			t.Fatalf("expected a settled pending request, got %+v", frame)
		}
	default:
		t.Fatal("pending request was not settled")
	}
	select {
	case <-disconnected:
	default:
		t.Fatal("heartbeat stop signal was not closed")
	}
	if err := bridge.ensureConnected(context.Background(), "fixture", nil); err == nil {
		t.Fatal("a closed client must not restart the host")
	}
}

func subscriptionClientFixture(t *testing.T) *bridgeClient {
	t.Helper()
	left, right := net.Pipe()
	client := &bridgeClient{conn: left, pending: make(map[string]chan bridgeFrame), disconnected: make(chan struct{})}
	go client.readLoop(left, bufio.NewReader(left))
	done := make(chan struct{})
	go func() {
		defer close(done)
		reader := bufio.NewReader(right)
		for {
			frame, err := readBridgeFrame(reader)
			if err != nil {
				return
			}
			response := bridgeFrame{ID: frame.ID, Type: "result", Result: json.RawMessage(`{}`)}
			if frame.URI == "explore-better://jobs/unavailable-fixture" {
				response.Type = "error"
				response.Error = &bridgeError{Code: "NOT_FOUND", Message: "Fixture resource unavailable."}
			}
			if err := writeBridgeFrame(right, response); err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() { client.close(); right.Close(); <-done })
	return client
}

func TestSubscriptionsAreBoundedWithoutLosingDuplicatesOrReleasedSlots(t *testing.T) {
	client := subscriptionClientFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for index := 0; index < maxSubscriptions; index++ {
		if err := client.setSubscription(ctx, "fixture", nil, fmt.Sprintf("explore-better://jobs/fixture-%d", index), true); err != nil {
			t.Fatal(err)
		}
	}
	if err := client.setSubscription(ctx, "fixture", nil, "explore-better://jobs/fixture-0", true); err != nil {
		t.Fatalf("duplicate subscription must remain idempotent: %v", err)
	}
	err := client.setSubscription(ctx, "fixture", nil, "explore-better://jobs/next", true)
	var limit *bridgeError
	if !errors.As(err, &limit) || limit.Code != "LIMIT_EXCEEDED" {
		t.Fatalf("expected subscription limit, got %v", err)
	}
	if err := client.setSubscription(ctx, "fixture", nil, "explore-better://jobs/fixture-0", false); err != nil {
		t.Fatal(err)
	}
	if err := client.setSubscription(ctx, "fixture", nil, "explore-better://jobs/unavailable-fixture", true); err == nil {
		t.Fatal("a failed remote subscription must not be accepted")
	}
	if err := client.setSubscription(ctx, "fixture", nil, "explore-better://jobs/next", true); err != nil {
		t.Fatalf("unsubscribing must release capacity: %v", err)
	}
	if len(client.subscriptions) != maxSubscriptions {
		t.Fatalf("unexpected retained subscription count: %d", len(client.subscriptions))
	}
}

func TestConcurrentSubscriptionsCannotExceedTheirRetainedLimit(t *testing.T) {
	client := subscriptionClientFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client.subscriptions = make(map[string]struct{})
	for index := 0; index < maxSubscriptions-4; index++ {
		client.subscriptions[fmt.Sprintf("explore-better://jobs/retained-%d", index)] = struct{}{}
	}
	var pending sync.WaitGroup
	results := make(chan error, 12)
	for index := 0; index < 12; index++ {
		pending.Add(1)
		go func(index int) {
			defer pending.Done()
			results <- client.setSubscription(ctx, "fixture", nil, fmt.Sprintf("explore-better://jobs/new-%d", index), true)
		}(index)
	}
	pending.Wait()
	close(results)
	accepted, refused := 0, 0
	for err := range results {
		var limit *bridgeError
		if err == nil {
			accepted++
		} else if errors.As(err, &limit) && limit.Code == "LIMIT_EXCEEDED" {
			refused++
		} else {
			t.Fatalf("unexpected subscription result: %v", err)
		}
	}
	if accepted != 4 || refused != 8 || len(client.subscriptions) != maxSubscriptions {
		t.Fatalf("accepted=%d refused=%d retained=%d", accepted, refused, len(client.subscriptions))
	}
}

func TestOverlongSubscriptionURIRejectsBeforeConnecting(t *testing.T) {
	client := &bridgeClient{}
	err := client.setSubscription(context.Background(), "fixture", nil, strings.Repeat("é", maxResourceURIBytes/2+1), true)
	var limit *bridgeError
	if !errors.As(err, &limit) || limit.Code != "LIMIT_EXCEEDED" {
		t.Fatalf("expected UTF-8 URI byte limit before any connection attempt, got %v", err)
	}
	if len(client.subscriptions) != 0 {
		t.Fatal("an overlong URI must not create a truncated subscription")
	}
}

func reconnectingSubscriptionFixture(t *testing.T) *bridgeClient {
	t.Helper()
	pipeName := `\\.\pipe\explore-better-subscription-test-` + randomID()
	listener, err := winio.ListenPipe(pipeName, nil)
	if err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(t.TempDir(), "bridge.json")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(bridgeManifest{Version: bridgeProtocolVersion, PipeName: pipeName, Nonce: "ordinary-fixture", ExecutablePath: executable})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifest, data, 0600); err != nil {
		t.Fatal(err)
	}
	client := &bridgeClient{manifest: manifest, subscriptions: make(map[string]struct{})}
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		remote := make(map[string]bool)
		for {
			frame, err := readBridgeFrame(reader)
			if err != nil {
				return
			}
			response := bridgeFrame{ID: frame.ID, Type: "result", Result: json.RawMessage(`{}`)}
			switch frame.Op {
			case "hello":
				response.Type = "hello"
			case "subscribe":
				remote[frame.URI] = true
			case "unsubscribe":
				delete(remote, frame.URI)
			case "ping":
				response.Result, _ = json.Marshal(remote)
			}
			if err := writeBridgeFrame(conn, response); err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() { client.close(); listener.Close(); <-done })
	return client
}

func TestReconnectReplaysAcknowledgedSubscriptionChanges(t *testing.T) {
	for _, subscribe := range []bool{true, false} {
		t.Run(fmt.Sprintf("subscribe=%t", subscribe), func(t *testing.T) {
			client := reconnectingSubscriptionFixture(t)
			uri := "explore-better://jobs/ordinary-fixture"
			if !subscribe {
				client.subscriptions[uri] = struct{}{}
			}
			acknowledged, commit := make(chan struct{}), make(chan struct{})
			changed := make(chan error, 1)
			go func() {
				changed <- client.changeSubscription(context.Background(), uri, subscribe, func() error {
					// The old host acknowledged the change and disconnected before
					// this transaction could update its retained replay state.
					close(acknowledged)
					<-commit
					return nil
				})
			}()
			<-acknowledged
			ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
			err := client.ensureConnected(ctx, "fixture", nil)
			cancel()
			close(commit)
			if err != nil && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal(err)
			}
			if err := <-changed; err != nil {
				t.Fatal(err)
			}
			ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			result, err := client.call(ctx, "fixture", nil, "ping", bridgeFrame{})
			if err != nil {
				t.Fatal(err)
			}
			var remote map[string]bool
			if err := json.Unmarshal(result, &remote); err != nil {
				t.Fatal(err)
			}
			if remote[uri] != subscribe {
				t.Fatalf("reconnected host has subscription=%t, want acknowledged state=%t", remote[uri], subscribe)
			}
		})
	}
}

func TestWaitingSubscriptionHonorsCancellation(t *testing.T) {
	client := subscriptionClientFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	finished := make(chan error, 1)
	go func() {
		finished <- client.changeSubscription(context.Background(), "explore-better://jobs/held", true, func() error {
			close(entered)
			<-release
			return nil
		})
	}()
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- client.setSubscription(ctx, "fixture", nil, "explore-better://jobs/canceled", true) }()
	select {
	case err := <-result:
		if !errors.Is(err, context.DeadlineExceeded) {
			close(release)
			t.Fatalf("waiting subscription returned %v instead of cancellation", err)
		}
	case <-time.After(time.Second):
		close(release)
		t.Fatal("waiting subscription did not honor cancellation")
	}
	close(release)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if _, exists := client.subscriptions["explore-better://jobs/canceled"]; exists {
		t.Fatal("canceled waiter changed retained subscriptions")
	}
	if err := client.setSubscription(context.Background(), "fixture", nil, "explore-better://jobs/later", true); err != nil {
		t.Fatalf("cancellation left the subscription gate locked: %v", err)
	}
}

func TestToolResultTextCarriesCompactJSON(t *testing.T) {
	raw := json.RawMessage("{\n  \"schemaVersion\": \"1\",\n  \"status\": \"ok\",\n  \"data\": { \"text\": \"café\", \"entries\": [1, 2] }\n}")
	result := toolResult(raw, nil)
	text, ok := result.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if text.Text != `{"schemaVersion":"1","status":"ok","data":{"text":"café","entries":[1,2]}}` {
		t.Fatalf("text content does not carry the compact result JSON: %q", text.Text)
	}
	if result.StructuredContent == nil || result.IsError {
		t.Fatalf("structured result missing: %+v", result)
	}
}

func TestToolResultTextIsBoundedAtRuneBoundary(t *testing.T) {
	payload, _ := json.Marshal(map[string]any{"status": "ok", "data": strings.Repeat("é", maxToolResultTextBytes)})
	result := toolResult(payload, nil)
	text := result.Content[0].(*mcp.TextContent).Text
	if len(text) > maxToolResultTextBytes+300 || !strings.Contains(text, "[Truncated:") || !utf8.ValidString(text) {
		t.Fatalf("oversized text was not truncated cleanly: %d bytes", len(text))
	}
	object, ok := result.StructuredContent.(map[string]any)
	if !ok || len(object["data"].(string)) != len("é")*maxToolResultTextBytes {
		t.Fatal("structured content lost part of an oversized result")
	}
}

func TestSessionIdentityIsStableWithoutTransportSessionID(t *testing.T) {
	first, _ := sessionIdentity(nil)
	second, _ := sessionIdentity(nil)
	if first == "" || first != second || first != stableSessionID("") {
		t.Fatalf("session identity changed within one process: %q, %q", first, second)
	}
	if stableSessionID("http-session") != "http-session" {
		t.Fatal("a transport session ID was replaced")
	}
}

func TestRootsCacheRefreshesOnlyAfterInvalidation(t *testing.T) {
	cache := newRootsCache()
	key := new(int)
	calls := 0
	fetch := func(context.Context) ([]string, bool, error) {
		calls++
		return []string{fmt.Sprintf("file:///C:/root-%d", calls)}, true, nil
	}
	for range 3 {
		roots, provided, err := cache.get(context.Background(), key, fetch)
		if err != nil || !provided || roots[0] != "file:///C:/root-1" {
			t.Fatalf("cached roots: %v %v %v", roots, provided, err)
		}
	}
	cache.invalidate(key)
	roots, _, _ := cache.get(context.Background(), key, fetch)
	if calls != 2 || roots[0] != "file:///C:/root-2" {
		t.Fatalf("roots were not refreshed after list_changed: calls=%d roots=%v", calls, roots)
	}
	failing := func(context.Context) ([]string, bool, error) {
		return nil, true, &bridgeError{Code: "CLIENT_ROOTS_UNAVAILABLE"}
	}
	other := new(int)
	if _, _, err := cache.get(context.Background(), other, failing); err == nil {
		t.Fatal("expected a roots failure")
	}
	if _, _, err := cache.get(context.Background(), other, fetch); err != nil || calls != 3 {
		t.Fatalf("a failed roots request was cached: %v calls=%d", err, calls)
	}
	stale := new(int)
	_, _, _ = cache.get(context.Background(), stale, func(context.Context) ([]string, bool, error) {
		cache.invalidate(stale)
		return []string{"file:///C:/stale"}, true, nil
	})
	if roots, _, _ := cache.get(context.Background(), stale, fetch); roots[0] == "file:///C:/stale" {
		t.Fatal("roots fetched across a change notification were cached")
	}
}
