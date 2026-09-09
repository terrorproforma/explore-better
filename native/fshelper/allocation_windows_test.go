//go:build windows

package main

import (
	"syscall"
	"testing"
	"time"
)

func TestFiletimeMillisecondsAcrossSupportedCalendarRange(t *testing.T) {
	for _, year := range []int{1601, 1900, 1970, 2026, 2500} {
		t.Run(time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC).Format("2006"), func(t *testing.T) {
			instant := time.Date(year, 1, 1, 0, 0, 0, 123000000, time.UTC)
			want := instant.UnixMilli()
			// Construct 100 ns Windows ticks without converting through UnixNano,
			// whose int64 range is smaller than the Windows timestamp range.
			ticks := uint64(want+11644473600000) * 10000
			value := syscall.Filetime{LowDateTime: uint32(ticks), HighDateTime: uint32(ticks >> 32)}
			if got := filetimeMilliseconds(value); got != want {
				t.Fatalf("filetimeMilliseconds(%s) = %d, want %d", instant.Format(time.RFC3339Nano), got, want)
			}
		})
	}
}
