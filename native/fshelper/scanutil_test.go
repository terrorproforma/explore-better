package main

import "testing"

func TestIsNameSurrogateReparseOnlySkipsLinks(t *testing.T) {
	cases := []struct {
		name       string
		attributes uint32
		tag        uint32
		want       bool
	}{
		{"symlink", fileAttributeReparsePoint, 0xA000000C, true},
		{"junction or mount point", fileAttributeReparsePoint | 0x10, 0xA0000003, true},
		{"cloud placeholder", fileAttributeReparsePoint, 0x9000001A, false},
		{"WOF CompactOS", fileAttributeReparsePoint, 0x80000017, false},
		{"deduplication", fileAttributeReparsePoint | 0x200, 0x80000013, false},
		{"not a reparse point", 0x20, 0xA000000C, false},
	}
	for _, item := range cases {
		if got := isNameSurrogateReparse(item.attributes, item.tag); got != item.want {
			t.Errorf("%s: isNameSurrogateReparse(%#x, %#x) = %v, want %v", item.name, item.attributes, item.tag, got, item.want)
		}
	}
}

func TestExtendedLengthPathRoundTrip(t *testing.T) {
	cases := map[string]string{
		`C:\`:                  `\\?\C:\`,
		`d:\deep\folder`:       `\\?\d:\deep\folder`,
		`\\server\share\dir`:   `\\?\UNC\server\share\dir`,
		`\\?\C:\already`:       `\\?\C:\already`,
		`\\.\pipe\name`:        `\\.\pipe\name`,
		`relative\path`:        `relative\path`,
		`C:drive-relative`:     `C:drive-relative`,
		`1:\not-a-drive-lette`: `1:\not-a-drive-lette`,
	}
	for input, want := range cases {
		got := extendedLengthPath(input)
		if got != want {
			t.Errorf("extendedLengthPath(%q) = %q, want %q", input, got, want)
		}
		if input[0] != '\\' || input[1] != '\\' || input[2] != '?' {
			if back := stripExtendedLengthPrefix(got); back != input {
				t.Errorf("stripExtendedLengthPrefix(%q) = %q, want %q", got, back, input)
			}
		}
	}
}

func TestFileIDSetChargesEachFileOnce(t *testing.T) {
	for _, fileSystem := range []string{"NTFS", "ReFS"} {
		set := newFileIDSet(true, fileSystem)
		ntfsID := uint64(0x0013_0000_0031_ef0f)
		if !set.firstSighting(ntfsID) || set.firstSighting(ntfsID) {
			t.Fatalf("%s: a repeated file ID must only be charged once", fileSystem)
		}
		// Same MFT record with a different sequence number cannot coexist on
		// NTFS, but distinct records must stay distinct.
		if !set.firstSighting(ntfsID + 1) {
			t.Fatalf("%s: a distinct file ID was treated as a duplicate", fileSystem)
		}
		huge := uint64(1)<<40 | 7
		if !set.firstSighting(huge) || set.firstSighting(huge) {
			t.Fatalf("%s: IDs beyond the dense range must still be deduplicated", fileSystem)
		}
		if !set.firstSighting(0) || !set.firstSighting(0) {
			t.Fatalf("%s: zero file IDs must never be deduplicated", fileSystem)
		}
	}
	disabled := newFileIDSet(false, "FAT32")
	if !disabled.firstSighting(5) || !disabled.firstSighting(5) {
		t.Fatal("filesystems without hard links must not deduplicate")
	}
}
