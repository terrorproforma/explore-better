//go:build windows

package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
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
