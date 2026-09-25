//go:build windows

package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func discardWriter() *writer {
	return &writer{encoder: json.NewEncoder(io.Discard)}
}

func testClusterSize(t *testing.T, dir string) uint64 {
	t.Helper()
	volume, err := volumeGeometry(dir)
	if err != nil {
		t.Fatal(err)
	}
	return volume.ClusterSize
}

func TestCompactTreeEntriesStripsDriveRootPrefix(t *testing.T) {
	columns := compactTreeEntries(`C:\`, []fileEntry{{Path: `C:\Windows`, Directory: true}, {Path: `C:\pagefile.sys`}})
	if columns.Paths[0] != "Windows" || columns.Paths[1] != "pagefile.sys" {
		t.Fatalf("drive-root entries were not made relative: %q", columns.Paths)
	}
	columns = compactTreeEntries(`C:\Users\`, []fileEntry{{Path: `C:\Users\Public`}})
	if columns.Root != `C:\Users` || columns.Paths[0] != "Public" {
		t.Fatalf("folder entries were not made relative: root %q paths %q", columns.Root, columns.Paths)
	}
}

func TestTreeScansReportRealAllocationForSmallFiles(t *testing.T) {
	fixture := t.TempDir()
	cluster := testClusterSize(t, fixture)
	const files = 20
	for index := range files {
		// 2000 bytes is too large to stay resident in an NTFS file record, so
		// each file occupies one cluster even though its logical size is less.
		if err := os.WriteFile(filepath.Join(fixture, strings.Repeat("f", index+1)+".bin"), make([]byte, 2000), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	scanned, err := scanTree(context.Background(), request{ID: "scan", Path: fixture}, discardWriter())
	if err != nil {
		t.Fatal(err)
	}
	if got, want := scanned["allocatedBytes"].(uint64), uint64(files)*cluster; got != want {
		t.Fatalf("scan-tree allocated %d bytes, want %d (%d clusters of %d)", got, want, files, cluster)
	}
	analyzed, err := analyzeTree(context.Background(), request{ID: "analyze", Path: fixture}, discardWriter())
	if err != nil {
		t.Fatal(err)
	}
	root := analyzed["folderNodes"].([]analysisFolder)[0]
	if root.Allocated != uint64(files)*cluster || root.Logical != files*2000 {
		t.Fatalf("analyze-tree root = %d allocated / %d logical, want %d / %d", root.Allocated, root.Logical, uint64(files)*cluster, files*2000)
	}
	allocated, _, accuracy, err := allocatedSize(filepath.Join(fixture, "f.bin"), 2000)
	if err != nil || allocated != cluster || accuracy != "exact" {
		t.Fatalf("allocated-size = %d (%s, %v), want %d", allocated, accuracy, err, cluster)
	}
}

func TestTreeScansChargeHardlinksOnce(t *testing.T) {
	fixture := t.TempDir()
	original := filepath.Join(fixture, "original.bin")
	if err := os.WriteFile(original, make([]byte, 100000), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(original, filepath.Join(fixture, "link.bin")); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}
	cluster := testClusterSize(t, fixture)
	want := (100000 + cluster - 1) / cluster * cluster
	scanned, err := scanTree(context.Background(), request{ID: "scan", Path: fixture}, discardWriter())
	if err != nil {
		t.Fatal(err)
	}
	if scanned["allocatedBytes"].(uint64) != want || scanned["logicalBytes"].(uint64) != 200000 {
		t.Fatalf("scan-tree = %v allocated / %v logical, want %d / 200000", scanned["allocatedBytes"], scanned["logicalBytes"], want)
	}
	analyzed, err := analyzeTree(context.Background(), request{ID: "analyze", Path: fixture}, discardWriter())
	if err != nil {
		t.Fatal(err)
	}
	root := analyzed["folderNodes"].([]analysisFolder)[0]
	if root.Allocated != want || root.Logical != 200000 {
		t.Fatalf("analyze-tree = %d allocated / %d logical, want %d / 200000", root.Allocated, root.Logical, want)
	}
}

func TestTreeScansEnumerateLongPaths(t *testing.T) {
	fixture := t.TempDir()
	deep := fixture
	for len(deep) < 400 {
		deep = filepath.Join(deep, strings.Repeat("d", 40))
	}
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(deep, "deep-file.txt")
	if err := os.WriteFile(target, []byte("deep"), 0o644); err != nil {
		t.Fatal(err)
	}
	scanned, err := scanTree(context.Background(), request{ID: "scan", Path: fixture}, discardWriter())
	if err != nil {
		t.Fatal(err)
	}
	if scanned["files"].(int) != 1 || scanned["skipped"].(int) != 0 {
		t.Fatalf("scan-tree found %v files (%v skipped) below a %d-character path", scanned["files"], scanned["skipped"], len(target))
	}
	analyzed, err := analyzeTree(context.Background(), request{ID: "analyze", Path: fixture}, discardWriter())
	if err != nil {
		t.Fatal(err)
	}
	if analyzed["files"].(int) != 1 || analyzed["skipped"].(int) != 0 {
		t.Fatalf("analyze-tree found %v files (%v skipped) below a %d-character path", analyzed["files"], analyzed["skipped"], len(target))
	}
	browsed, err := browseDirectory(context.Background(), deep, 0, nil, false)
	if err != nil || browsed["returned"].(int) != 1 {
		t.Fatalf("browse of a long path returned %v (%v)", browsed["returned"], err)
	}
}

func TestTreeScansSkipJunctionsOnly(t *testing.T) {
	fixture := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "outside.bin"), make([]byte, 5000), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture, "inside.bin"), make([]byte, 5000), 0o644); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command("cmd", "/c", "mklink", "/J", filepath.Join(fixture, "junction"), outside).CombinedOutput(); err != nil {
		t.Skipf("junction unavailable: %v %s", err, output)
	}
	scanned, err := scanTree(context.Background(), request{ID: "scan", Path: fixture}, discardWriter())
	if err != nil {
		t.Fatal(err)
	}
	if scanned["files"].(int) != 1 || scanned["folders"].(int) != 0 || scanned["skipped"].(int) != 1 {
		t.Fatalf("scan-tree = %v files, %v folders, %v skipped; want the junction skipped", scanned["files"], scanned["folders"], scanned["skipped"])
	}
}

func TestAnalyzeTreeSerializesFolderPathsOnlyForRoot(t *testing.T) {
	fixture := t.TempDir()
	if err := os.MkdirAll(filepath.Join(fixture, "child", "grandchild"), 0o755); err != nil {
		t.Fatal(err)
	}
	analyzed, err := analyzeTree(context.Background(), request{ID: "analyze", Path: fixture}, discardWriter())
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(analyzed["folderNodes"])
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]interface{}
	if err := json.Unmarshal(encoded, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 || rows[0]["path"] != filepath.Clean(fixture) || rows[1]["path"] != nil || rows[2]["name"] != "grandchild" || rows[2]["parent"] != float64(1) {
		t.Fatalf("unexpected folder rows: %s", encoded)
	}
}

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
